// Package mssql provides SQL Server specific dialect execution and query generation for AN5 Go Adapters.
package mssql

import (
	"an5adapters/base"
	"fmt"
	"strings"
)

// BuildVectorSearchQuery constructs native SQL Server VECTOR_DISTANCE query.
func BuildVectorSearchQuery(table, field, metric string, dim, take int, where string) string {
	if field == "" {
		field = "embedding"
	}
	if metric == "" {
		metric = "cosine"
	}
	tableSql := base.QuoteTable(table, base.DialectMssql)
	fieldSql := base.QuoteIdentifier(field, base.DialectMssql)

	query := fmt.Sprintf(
		"SELECT TOP (%d) *, VECTOR_DISTANCE('%s', CAST(%s AS VECTOR(%d, float32)), CAST(? AS VECTOR(%d, float32))) AS distance FROM %s WITH (NOLOCK)",
		take, metric, fieldSql, dim, dim, tableSql,
	)
	if strings.TrimSpace(where) != "" {
		query += fmt.Sprintf(" WHERE %s IS NOT NULL AND (%s)", fieldSql, where)
	} else {
		query += fmt.Sprintf(" WHERE %s IS NOT NULL", fieldSql)
	}
	query += " ORDER BY distance ASC"
	return query
}
