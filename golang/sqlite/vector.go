// Package sqlite provides SQLite specific dialect execution and query generation for AN5 Go Adapters.
//
// SQLite has no vector type, so a `VECTOR(n)` column stores a BLOB of little-endian
// float32 values and is ranked in one of four ways, in this order:
//
//  1. sqlite-vec  native scalar distances, when the driver loaded the extension.
//  2. udf         an5_vec_cosine / an5_vec_l2 / an5_vec_ip registered with the
//     driver. Reads the BLOB and the legacy JSON text.
//  3. sql         json_each brute force in plain SQL. Needs no user function, so it
//     works with any driver, but only reaches rows stored as JSON text.
//  4. memory      the column is loaded and scored in Go.
//
// Strategies 1-3 rank inside the database and transfer only the matching rows,
// which is why they are preferred over the in-memory path.
package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"an5adapters/base"
)

// BuildVectorSearchQuery returns empty string as SQLite ranks through its own
// strategies; see RunVectorSearch for the statements it builds.
func BuildVectorSearchQuery(table, field, metric string, dim, take int, where string) string {
	_ = base.QuoteTable(table, base.DialectSqlite)
	_ = base.QuoteIdentifier(field, base.DialectSqlite)
	// Native vector extension not present in standard sqlite; in-memory fallback is used.
	return ""
}

// VectorSupport carries what a SQLite connection needs for in-database vector
// search: the path to the sqlite-vec extension to load and a strategy to pin
// instead of probing.
type VectorSupport struct {
	// SqliteVecPath names the sqlite-vec extension binary. It is only used to
	// report what the caller asked for; loading the extension is the driver's
	// job (mattn/go-sqlite3 takes it in the DSN as `_loc`/`_x` style options, and
	// modernc.org/sqlite through its own LoadExtension API).
	SqliteVecPath string
	// VectorStrategy pins "sqlite-vec", "udf", "sql" or "memory". Empty probes.
	VectorStrategy string
}

// ScalarFuncRegistrar installs a scalar function with a driver. `database/sql`
// has no API for this, so a driver has to hand one over:
//
//	sql.Register("an5-sqlite3", &sqlite3.SQLiteDriver{
//	    ConnectHook: func(c *sqlite3.SQLiteConn) error {
//	        return sqlite.RegisterVectorFunctions(c.RegisterFunc)
//	    },
//	})
func RegisterVectorFunctions(register func(name string, impl interface{}, pure bool) error) error {
	for metric, name := range base.An5VectorFunctions {
		captured := metric
		if err := register(name, func(a, b interface{}) interface{} {
			distance, ok := base.VectorDistance(base.DecodeVector(a), base.DecodeVector(b), captured)
			if !ok { return nil }
			return distance
		}, true); err != nil {
			return err
		}
	}
	return nil
}

// Capabilities probes what this connection can do, once per call. Both probes are
// cheap `SELECT`s; the sqlite-vec one fails on a connection without the extension,
// and the user-function one on a driver that never registered them.
func Capabilities(ctx context.Context, db *sql.DB) map[string]bool {
	caps := map[string]bool{"vec": false, "udf": false, "json1": false}
	if db == nil {
		return caps
	}

	row := db.QueryRowContext(ctx, "SELECT vec_version()")
	var version interface{}
	if err := row.Scan(&version); err == nil {
		caps["vec"] = true
	}

	// The probe has to reach a real distance: a driver that resolved the name
	// would still fail on the arguments otherwise.
	row = db.QueryRowContext(ctx, "SELECT an5_vec_cosine(zeroblob(4), zeroblob(4))")
	var distance interface{}
	if err := row.Scan(&distance); err == nil {
		caps["udf"] = true
	}

	row = db.QueryRowContext(ctx, "SELECT json_valid('[1]')")
	var jsonOK interface{}
	if err := row.Scan(&jsonOK); err == nil {
		caps["json1"] = true
	}

	return caps
}

// ReadColumnType returns a vector column's declared DDL type, or "" when the
// table or column is not there.
func ReadColumnType(ctx context.Context, db *sql.DB, table, column string) string {
	row := db.QueryRowContext(ctx, "SELECT type FROM pragma_table_info(?) WHERE name = ?", table, column)
	var declared sql.NullString
	if err := row.Scan(&declared); err != nil || !declared.Valid {
		return ""
	}
	return declared.String
}

// jsonText guards the JSON path: `json_valid` fails on a float32 BLOB.
func jsonText(column string) string {
	return fmt.Sprintf("CASE WHEN json_valid(%s) THEN %s ELSE '[]' END", column, column)
}

func jsonDistanceExpr(metric, column string) string {
	row := jsonText(column)
	sameLength := fmt.Sprintf("(SELECT COUNT(*) FROM json_each(%s)) = (SELECT COUNT(*) FROM q)", row)

	var terms string
	switch metric {
	case "euclidean":
		terms = fmt.Sprintf("sqrt((SELECT SUM((je.value - q.v) * (je.value - q.v)) FROM json_each(%s) je JOIN q ON q.k = je.key))", row)
	case "dot":
		terms = fmt.Sprintf("-(SELECT SUM(je.value * q.v) FROM json_each(%s) je JOIN q ON q.k = je.key)", row)
	default:
		terms = fmt.Sprintf("1.0 - (SELECT SUM(je.value * q.v) FROM json_each(%s) je JOIN q ON q.k = je.key)"+
			" / NULLIF(sqrt((SELECT SUM(q.v * q.v) FROM q)) * sqrt((SELECT SUM(je.value * je.value) FROM json_each(%s) je)), 0)", row, row)
	}
	return fmt.Sprintf("CASE WHEN %s THEN %s END", sameLength, terms)
}

// BuildRankingQuery returns the ranking SQL for one strategy, with the arguments
// the query vector needs appended to `args`.
//
// sqlite-vec and udf bind the query vector as a float32 BLOB; sql binds it as
// JSON text because json_each reads text.
//
// A row whose stored vector cannot be scored (a NULL, a text column, another
// dimension) yields a NULL distance; those rows are dropped rather than reported,
// so a caller never has to sort them out of the result.
func BuildRankingQuery(strategy, metric, table, column string, vector []float64, take int, tail string, args []interface{}) (string, []interface{}) {
	rank := func(inner string) string {
		return fmt.Sprintf("SELECT * FROM (%s) AS an5_ranked WHERE distance IS NOT NULL ORDER BY distance ASC LIMIT %d", inner, take)
	}

	switch metric {
	case "euclidean", "dot":
	default:
		metric = "cosine"
	}

	if strategy == base.VectorStrategySqliteVec {
		fn, ok := base.SqliteVecFunctions[metric]
		if !ok {
			return "", args
		}
		// sqlite-vec only understands float32 BLOB operands, so rows stored any
		// other way are excluded instead of aborting the query. The guard joins the
		// caller's WHERE with AND, since the ranking query is where both apply.
		guard := fmt.Sprintf("%s IS NOT NULL", column)
		// `tail` carries its own leading " WHERE", so it is appended after AND.
		if tail != "" {
			guard += " AND" + strings.Replace(tail, " WHERE ", " ", 1)
		}
		inner := fmt.Sprintf("SELECT *, CASE WHEN vec_length(vec_f32(%s)) = %d THEN %s(vec_f32(%s), ?) END AS distance FROM %s WHERE %s",
			column, len(vector), fn, column, table, guard)
		return rank(inner), append([]interface{}{base.EncodeVector(vector)}, args...)
	}

	if strategy == base.VectorStrategyUdf {
		fn, ok := base.An5VectorFunctions[metric]
		if !ok {
			return "", args
		}
		inner := fmt.Sprintf("SELECT *, %s(%s, ?) AS distance FROM %s%s", fn, column, table, tail)
		return rank(inner), append([]interface{}{base.EncodeVector(vector)}, args...)
	}

	payload, err := json.Marshal(vector)
	if err != nil {
		return "", args
	}
	inner := fmt.Sprintf("SELECT *, %s AS distance FROM %s%s", jsonDistanceExpr(metric, column), table, tail)
	prefix := "WITH q AS (SELECT je.key AS k, CAST(je.value AS REAL) AS v FROM json_each(?) je) "
	return prefix + rank(inner), append([]interface{}{string(payload)}, args...)
}

// RunVectorSearch ranks a SQLite table inside the database, trying each available
// strategy in order. It reports whether a strategy ran: when none does, the
// caller falls back to scoring in memory.
func RunVectorSearch(
	ctx context.Context,
	db *sql.DB,
	exec func(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error),
	table, rawTable, column, rawColumn string,
	vector []float64,
	metric string,
	take int,
	tail string,
	args []interface{},
	support VectorSupport,
) ([]map[string]interface{}, bool, error) {
	if len(vector) == 0 {
		return nil, false, nil
	}

	caps := Capabilities(ctx, db)
	if db == nil {
		return nil, false, nil
	}
	declared := ReadColumnType(ctx, db, rawTable, rawColumn)

	for _, strategy := range base.PlanVectorStrategies(caps, declared, support.VectorStrategy) {
		if strategy == base.VectorStrategySQL {
			clause := " WHERE "
			if tail != "" { clause = tail + " AND " }
			binary, err := exec(ctx, "SELECT 1 FROM " + table + clause + "typeof(" + column + ") = 'blob' LIMIT 1", args...)
			if err != nil || len(binary) > 0 { continue }
		}
		query, queryArgs := BuildRankingQuery(strategy, metric, table, column, vector, take, tail, args)
		if query == "" {
			continue
		}
		rows, err := exec(ctx, query, queryArgs...)
		if err == nil {
			return rows, true, nil
		}
		// The connection advertised the capability but the query failed, e.g. an
		// extension that did not really load. The next strategy is cheaper than
		// reporting the failure, and memory is the last resort.
	}
	return nil, false, nil
}

// NormalizeTableName reduces a mapped table name to the bare name
// `pragma_table_info` takes as a plain string: the last segment of a qualified
// name, with the quoting a generated client may have left around it removed.
func NormalizeTableName(name string) string {
	trimmed := strings.TrimSpace(name)
	if index := strings.LastIndex(trimmed, "."); index >= 0 {
		trimmed = trimmed[index+1:]
	}
	return strings.Trim(trimmed, "[]`\"")
}
