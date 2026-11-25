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
	DialectSqlite   Dialect = "sqlite"
)

// DetectDialect parses connection string to determine database dialect.
func DetectDialect(connStr string) Dialect {
	lower := strings.ToLower(strings.TrimSpace(connStr))
	if strings.HasPrefix(lower, "postgres://") || strings.HasPrefix(lower, "postgresql://") || strings.Contains(lower, "port=5432") {
		return DialectPostgres
	}
	if strings.HasPrefix(lower, "sqlite://") || strings.HasPrefix(lower, "sqlite:") || strings.HasPrefix(lower, "file:") || strings.HasSuffix(lower, ".db") || strings.HasSuffix(lower, ".sqlite") || strings.HasSuffix(lower, ".sqlite3") || lower == ":memory:" {
		return DialectSqlite
	}
	return DialectMssql
}

// QuoteIdentifier quotes column or identifier names according to dialect.
func QuoteIdentifier(name string, dialect Dialect) string {
	raw := stripWrapping(name, "[", "]")
	if dialect == DialectPostgres || dialect == DialectSqlite {
		raw = stripWrapping(raw, `"`, `"`)
		return `"` + strings.ReplaceAll(raw, `"`, `""`) + `"`
	}
	return "[" + strings.ReplaceAll(raw, "]", "]]") + "]"
}

// QuoteTable quotes schema-qualified table names (e.g. "dbo.users" -> "[dbo].[users]").
// On SQLite, a leading "dbo." schema qualifier is stripped because SQLite attaches tables directly.
func QuoteTable(tableName string, dialect Dialect) string {
	rawParts := strings.Split(tableName, ".")
	cleaned := make([]string, 0, len(rawParts))
	for _, p := range rawParts {
		seg := strings.TrimSpace(p)
		seg = stripWrapping(seg, "[", "]")
		seg = stripWrapping(seg, `"`, `"`)
		seg = stripWrapping(seg, "`", "`")
		if seg != "" {
			cleaned = append(cleaned, seg)
		}
	}
	if len(cleaned) == 0 {
		return QuoteIdentifier(tableName, dialect)
	}
	if dialect == DialectSqlite && len(cleaned) == 2 && strings.EqualFold(cleaned[0], "dbo") {
		cleaned = cleaned[1:]
	}
	quoted := make([]string, len(cleaned))
	for i, p := range cleaned {
		quoted[i] = QuoteIdentifier(p, dialect)
	}
	return strings.Join(quoted, ".")
}

// ToSnakeCase converts camelCase/PascalCase identifiers to snake_case.
func ToSnakeCase(s string) string {
	if s == "" {
		return ""
	}
	runes := []rune(s)
	var b strings.Builder
	b.Grow(len(runes) + 4)
	for i, r := range runes {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				prev := runes[i-1]
				hasNextLower := i+1 < len(runes) && runes[i+1] >= 'a' && runes[i+1] <= 'z'
				prevIsUpper := prev >= 'A' && prev <= 'Z'
				if prev != '_' && (!prevIsUpper || hasNextLower) {
					b.WriteByte('_')
				}
			}
			b.WriteRune(r + ('a' - 'A'))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
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
