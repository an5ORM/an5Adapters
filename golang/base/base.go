// Package base provides core dialect types, quoting utilities, and vector math for AN5 Go Adapters.
package base

import (
	"math"
	"strings"
)

// Dialect represents supported database engines.
type Dialect string

const (
	DialectMssql    Dialect = "mssql"
	DialectPostgres Dialect = "postgres"
)

// DetectDialect parses connection string to determine database dialect.
func DetectDialect(connStr string) Dialect {
	lower := strings.ToLower(connStr)
	if strings.HasPrefix(lower, "postgres://") || strings.HasPrefix(lower, "postgresql://") || strings.Contains(lower, "port=5432") {
		return DialectPostgres
	}
	return DialectMssql
}

// QuoteIdentifier quotes column or identifier names according to dialect.
func QuoteIdentifier(name string, dialect Dialect) string {
	raw := stripWrapping(name, "[", "]")
	if dialect == DialectPostgres {
		raw = stripWrapping(raw, `"`, `"`)
		return `"` + strings.ReplaceAll(raw, `"`, `""`) + `"`
	}
	return "[" + strings.ReplaceAll(raw, "]", "]]") + "]"
}

// QuoteTable quotes schema-qualified table names (e.g. "dbo.users" -> "[dbo].[users]").
func QuoteTable(tableName string, dialect Dialect) string {
	if strings.HasPrefix(tableName, "[") || strings.HasPrefix(tableName, `"`) {
		return tableName
	}
	parts := strings.Split(tableName, ".")
	var quoted []string
	for _, p := range parts {
		quoted = append(quoted, QuoteIdentifier(p, dialect))
	}
	return strings.Join(quoted, ".")
}

func stripWrapping(name, left, right string) string {
	if strings.HasPrefix(name, left) && strings.HasSuffix(name, right) {
		return strings.TrimSuffix(strings.TrimPrefix(name, left), right)
	}
	return name
}

// CosineSimilarity computes cosine similarity between two float64 vectors.
func CosineSimilarity(v1, v2 []float64) float64 {
	if len(v1) != len(v2) || len(v1) == 0 {
		return 0
	}
	var dot, m1, m2 float64
	for i := 0; i < len(v1); i++ {
		dot += v1[i] * v2[i]
		m1 += v1[i] * v1[i]
		m2 += v2[i] * v2[i]
	}
	if m1 == 0 || m2 == 0 {
		return 0
	}
	return dot / (math.Sqrt(m1) * math.Sqrt(m2))
}

// EuclideanDistance computes L2 distance between two float64 vectors.
func EuclideanDistance(v1, v2 []float64) float64 {
	if len(v1) != len(v2) || len(v1) == 0 {
		return 0
	}
	var sum float64
	for i := 0; i < len(v1); i++ {
		diff := v1[i] - v2[i]
		sum += diff * diff
	}
	return math.Sqrt(sum)
}

// DotProduct computes inner product of two float64 vectors.
func DotProduct(v1, v2 []float64) float64 {
	if len(v1) != len(v2) || len(v1) == 0 {
		return 0
	}
	var dot float64
	for i := 0; i < len(v1); i++ {
		dot += v1[i] * v2[i]
	}
	return dot
}
