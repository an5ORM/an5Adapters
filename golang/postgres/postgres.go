// Package postgres provides PostgreSQL specific dialect execution and pgvector query generation for AN5 Go Adapters.
// pgvector operators: <=> (cosine), <-> (euclidean), <#> (dot product).
package postgres

import (
	"an5adapters/base"
	"fmt"
	"strings"
)

// BuildVectorSearchQuery constructs native PostgreSQL pgvector query.
func BuildVectorSearchQuery(table, field, metric string, dim, take int, where string) string {
	if field == "" {
		field = "embedding"
	}
	if metric == "" {
		metric = "cosine"
	}
	tableSql := base.QuoteTable(table, base.DialectPostgres)
	fieldSql := base.QuoteIdentifier(field, base.DialectPostgres)

	op := "<=>"
	if strings.EqualFold(metric, "euclidean") {
		op = "<->"
	} else if strings.EqualFold(metric, "dot") {
		op = "<#>"
	}

	query := fmt.Sprintf("SELECT *, (%s %s $1::vector) AS distance FROM %s", fieldSql, op, tableSql)
	if strings.TrimSpace(where) != "" {
		query += fmt.Sprintf(" WHERE %s IS NOT NULL AND (%s)", fieldSql, where)
	} else {
		query += fmt.Sprintf(" WHERE %s IS NOT NULL", fieldSql)
	}
	query += fmt.Sprintf(" ORDER BY distance ASC LIMIT %d", take)
	return query
}
