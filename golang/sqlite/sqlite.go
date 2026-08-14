// Package sqlite provides SQLite specific dialect execution and query generation for AN5 Go Adapters.
package sqlite

import (
	"an5adapters/base"
)

// BuildVectorSearchQuery returns empty string as SQLite uses in-memory vector fallback by default.
func BuildVectorSearchQuery(table, field, metric string, dim, take int, where string) string {
	_ = base.QuoteTable(table, base.DialectSqlite)
	_ = base.QuoteIdentifier(field, base.DialectSqlite)
	// Native vector extension not present in standard sqlite; in-memory fallback is used.
	return ""
}
