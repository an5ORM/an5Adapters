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
)

// Re-export core base types and functions for package root convenience.
type Dialect = base.Dialect
type AdapterMetadata = base.AdapterMetadata

const (
	DialectMssql    = base.DialectMssql
	DialectPostgres = base.DialectPostgres
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

// An5Adapter manages runtime database execution for Go applications.
type An5Adapter struct {
	DB      *sql.DB
	Dialect Dialect
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

	// 1. Primary path: Native database SQL vector query execution via dialect provider (mssql / postgres)
	var sqlQuery string
	if a.Dialect == base.DialectPostgres {
		sqlQuery = postgres.BuildVectorSearchQuery(tableName, vectorField, distanceMetric, dim, take, whereClause)
	} else {
		sqlQuery = mssql.BuildVectorSearchQuery(tableName, vectorField, distanceMetric, dim, take, whereClause)
	}

	queryArgs := append([]interface{}{vecStr}, args...)
	nativeRows, err := a.QueryRaw(ctx, sqlQuery, queryArgs...)
	if err == nil {
		return nativeRows, nil
	}

	// 2. Secondary fallback: Fetch rows and compute vector distance in-memory if DB lacks native vector extensions
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

		var rowVec []float64
		switch v := raw.(type) {
		case string:
			_ = json.Unmarshal([]byte(v), &rowVec)
		case []byte:
			_ = json.Unmarshal(v, &rowVec)
		case []float64:
			rowVec = v
		case []interface{}:
			for _, item := range v {
				if f, ok := item.(float64); ok {
					rowVec = append(rowVec, f)
				}
			}
		}

		if len(rowVec) != len(targetVector) {
			continue
		}

		var dist float64
		switch strings.ToLower(distanceMetric) {
		case "euclidean":
			dist = base.EuclideanDistance(targetVector, rowVec)
		case "dot":
			dist = -base.DotProduct(targetVector, rowVec)
		default: // cosine
			dist = 1.0 - base.CosineSimilarity(targetVector, rowVec)
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
