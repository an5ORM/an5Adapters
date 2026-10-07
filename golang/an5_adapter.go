// Package an5adapters provides standalone database adapter engines for Go applications.
package an5adapters

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"

	"an5adapters/base"
	"an5adapters/mssql"
	"an5adapters/postgres"
	"an5adapters/sqlite"
)

// Re-export core base types and functions for package root convenience.
type Dialect = base.Dialect
type AdapterMetadata = base.AdapterMetadata
type RelationDef = base.RelationDef

const (
	DialectMssql    = base.DialectMssql
	DialectPostgres = base.DialectPostgres
	DialectSqlite   = base.DialectSqlite
)

func DetectDialect(connStr string) Dialect {
	return base.DetectDialect(connStr)
}

func QuoteIdentifier(name string, dialect Dialect) string {
	return base.QuoteIdentifier(name, dialect)
}

func QuoteTable(tableName string, dialect Dialect) string {
	return base.QuoteTable(tableName, dialect)
}

func CosineSimilarity(v1, v2 []float64) float64 {
	return base.CosineSimilarity(v1, v2)
}

func EuclideanDistance(v1, v2 []float64) float64 {
	return base.EuclideanDistance(v1, v2)
}

func DotProduct(v1, v2 []float64) float64 {
	return base.DotProduct(v1, v2)
}

// SetAdapterMetadata injects model-to-table metadata from the generated client.
func SetAdapterMetadata(meta AdapterMetadata) {
	base.SetAdapterMetadata(meta)
}

// GetModelToTable returns the current model-to-table mapping.
func GetModelToTable() map[string]string {
	return base.GetModelToTable()
}

// GetRelationsForModel returns the relation definitions for the given model name.
func GetRelationsForModel(modelName string) map[string]RelationDef {
	return base.GetRelationsForModel(modelName)
}

// An5Adapter manages runtime database execution for Go applications.
type An5Adapter struct {
	DB      *sql.DB
	Dialect Dialect
	// VectorSupport carries the SQLite vector settings. Set it before the first
	// search to load sqlite-vec or to pin a strategy.
	VectorSupport sqlite.VectorSupport
}

// NewAn5Adapter constructs an An5Adapter instance.
func NewAn5Adapter(db *sql.DB, connStr string) *An5Adapter {
	return &An5Adapter{
		DB:      db,
		Dialect: base.DetectDialect(connStr),
	}
}

// Connect validates the database connection (ping).
func (a *An5Adapter) Connect(ctx context.Context) error {
	return a.DB.PingContext(ctx)
}

// Disconnect closes the underlying database connection pool.
func (a *An5Adapter) Disconnect() error {
	return a.DB.Close()
}

// QueryRaw executes a SELECT query and returns rows as maps.
func (a *An5Adapter) QueryRaw(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error) {
	rows, err := a.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var results []map[string]interface{}
	for rows.Next() {
		columns := make([]interface{}, len(cols))
		columnPointers := make([]interface{}, len(cols))
		for i := range columns {
			columnPointers[i] = &columns[i]
		}

		if err := rows.Scan(columnPointers...); err != nil {
			return nil, err
		}

		m := make(map[string]interface{})
		for i, colName := range cols {
			val := columnPointers[i].(*interface{})
			m[colName] = *val
		}
		results = append(results, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

// ExecuteRaw executes an INSERT, UPDATE, or DELETE query and returns affected rows count.
func (a *An5Adapter) ExecuteRaw(ctx context.Context, query string, args ...interface{}) (int64, error) {
	res, err := a.DB.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Transaction executes a function within a database transaction.
func (a *An5Adapter) Transaction(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// VectorSearch ranks rows by vector distance using native SQL execution with in-memory fallback.
func (a *An5Adapter) VectorSearch(ctx context.Context, tableName string, targetVector []float64, take int, whereClause string, vectorField string, distanceMetric string, args ...interface{}) ([]map[string]interface{}, error) {
	if vectorField == "" {
		vectorField = "embedding"
	}
	if distanceMetric == "" {
		distanceMetric = "cosine"
	}
	dim := len(targetVector)
	vecBytes, _ := json.Marshal(targetVector)
	vecStr := string(vecBytes)

	// 1. SQLite ranks through sqlite-vec, a driver function or json_each,
	//    whichever this connection supports, so the table never has to leave the
	//    database. `database/sql` cannot register a user function, so the UDF
	//    strategy needs the driver to install them; see sqlite.RegisterVectorFunctions.
	if a.Dialect == base.DialectSqlite {
		tail := ""
		if strings.TrimSpace(whereClause) != "" {
			tail = " WHERE " + whereClause
		}
		support := a.VectorSupport
		ranked, ran, err := sqlite.RunVectorSearch(
			ctx,
			a.DB,
			a.QueryRaw,
			base.QuoteTable(tableName, a.Dialect),
			sqlite.NormalizeTableName(tableName),
			base.QuoteIdentifier(vectorField, a.Dialect),
			vectorField,
			targetVector,
			distanceMetric,
			take,
			tail,
			args,
			support,
		)
		if err != nil {
			return nil, err
		}
		if ran {
			return DecodeVectorRows(ranked, vectorField), nil
		}
		// No in-database strategy: score the column in Go instead.
		return a.vectorSearchInMemory(ctx, tableName, targetVector, take, whereClause, vectorField, distanceMetric, args)
	}

	// 2. Primary path: Native database SQL vector query execution via dialect provider (mssql / postgres)
	var sqlQuery string
	if a.Dialect == base.DialectPostgres {
		sqlQuery = postgres.BuildVectorSearchQuery(tableName, vectorField, distanceMetric, dim, take, whereClause)
	} else if a.Dialect == base.DialectMssql {
		sqlQuery = mssql.BuildVectorSearchQuery(tableName, vectorField, distanceMetric, dim, take, whereClause)
	}

	if sqlQuery != "" {
		queryArgs := append([]interface{}{vecStr}, args...)
		nativeRows, err := a.QueryRaw(ctx, sqlQuery, queryArgs...)
		if err == nil {
			return nativeRows, nil
		}
	}

	// 3. Secondary fallback: Fetch rows and compute vector distance in-memory if DB lacks native vector extensions
	fallbackQuery := "SELECT * FROM " + base.QuoteTable(tableName, a.Dialect)
	if strings.TrimSpace(whereClause) != "" {
		fallbackQuery += " WHERE " + whereClause
	}

	rows, err := a.QueryRaw(ctx, fallbackQuery, args...)
	if err != nil {
		return nil, err
	}

	return VectorSearchFallback(rows, targetVector, take, vectorField, distanceMetric), nil
}

// vectorSearchInMemory loads the table and scores the vector column in Go.
//
// The last resort for every provider, and the only option on a SQLite connection
// that offers neither sqlite-vec, a driver function nor JSON1. The whole table is
// loaded, so it is only reasonable for a table small enough to fit in memory.
func (a *An5Adapter) vectorSearchInMemory(ctx context.Context, tableName string, targetVector []float64, take int, whereClause string, vectorField string, distanceMetric string, args []interface{}) ([]map[string]interface{}, error) {
	query := "SELECT * FROM " + base.QuoteTable(tableName, a.Dialect)
	if strings.TrimSpace(whereClause) != "" {
		query += " WHERE " + whereClause
	}
	rows, err := a.QueryRaw(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return VectorSearchFallback(rows, targetVector, take, vectorField, distanceMetric), nil
}

// DecodeVectorRows replaces every stored `VECTOR(n)` column with a decoded
// float64 slice, so a caller reads numbers rather than float32 bytes or JSON text.
func DecodeVectorRows(rows []map[string]interface{}, vectorField string) []map[string]interface{} {
	for _, row := range rows {
		for key, value := range row {
			if key != vectorField {
				continue
			}
			decoded := base.DecodeVector(value)
			if decoded == nil {
				continue
			}
			// A `distance` column is a real number, not a stored vector.
			if key == "distance" {
				continue
			}
			row[key] = decoded
		}
	}
	return rows
}

// VectorSearchFallback ranks rows in-memory.
func VectorSearchFallback(rows []map[string]interface{}, targetVector []float64, take int, vectorField string, distanceMetric string) []map[string]interface{} {
	type scored struct {
		row      map[string]interface{}
		distance float64
	}
	var list []scored

	for _, r := range rows {
		raw, ok := r[vectorField]
		if !ok || raw == nil {
			continue
		}

		// A float32 BLOB, a legacy JSON text column and an already-decoded slice
		// all read the same way.
		rowVec := base.DecodeVector(raw)
		dist, ok := base.VectorDistance(targetVector, rowVec, distanceMetric)
		if !ok {
			continue
		}

		rCopy := make(map[string]interface{})
		for k, val := range r {
			rCopy[k] = val
		}
		rCopy["distance"] = dist
		list = append(list, scored{row: rCopy, distance: dist})
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].distance < list[j].distance
	})

	var result []map[string]interface{}
	limit := take
	if limit <= 0 || limit > len(list) {
		limit = len(list)
	}
	for i := 0; i < limit; i++ {
		result = append(result, list[i].row)
	}
	return result
}

// QueryProc executes a stored procedure and returns the result rows.
func (a *An5Adapter) QueryProc(ctx context.Context, procName string, args ...interface{}) ([]map[string]interface{}, error) {
	var sql string
	if a.Dialect == base.DialectPostgres {
		placeholders := make([]string, len(args))
		for i := range args {
			placeholders[i] = placeholder(a.Dialect, i+1)
		}
		sql = "CALL " + procName + "(" + strings.Join(placeholders, ", ") + ")"
	} else {
		placeholders := make([]string, len(args))
		for i := range args {
			placeholders[i] = "?"
		}
		if len(placeholders) > 0 {
			sql = "EXEC " + procName + " " + strings.Join(placeholders, ", ")
		} else {
			sql = "EXEC " + procName
		}
	}
	return a.QueryRaw(ctx, sql, args...)
}

// ExecuteProc executes a stored procedure and returns affected rows.
func (a *An5Adapter) ExecuteProc(ctx context.Context, procName string, args ...interface{}) (int64, error) {
	var sql string
	if a.Dialect == base.DialectPostgres {
		placeholders := make([]string, len(args))
		for i := range args {
			placeholders[i] = placeholder(a.Dialect, i+1)
		}
		sql = "CALL " + procName + "(" + strings.Join(placeholders, ", ") + ")"
	} else {
		placeholders := make([]string, len(args))
		for i := range args {
			placeholders[i] = "?"
		}
		if len(placeholders) > 0 {
			sql = "EXEC " + procName + " " + strings.Join(placeholders, ", ")
		} else {
			sql = "EXEC " + procName
		}
	}
	return a.ExecuteRaw(ctx, sql, args...)
}
