package an5adapters_test

import (
	"testing"

	an5adapters "an5adapters"
	"an5adapters/base"
)

func TestSqliteDialectDetection(t *testing.T) {
	tests := []struct {
		connStr  string
		expected base.Dialect
	}{
		{"sqlite://data/test.db", base.DialectSqlite},
		{"sqlite:memory:", base.DialectSqlite},
		{"file:mydb.sqlite3", base.DialectSqlite},
		{"app.db", base.DialectSqlite},
		{":memory:", base.DialectSqlite},
		{"postgres://user:pass@localhost:5432/db", base.DialectPostgres},
		{"Server=localhost;Database=master;", base.DialectMssql},
	}

	for _, tt := range tests {
		got := an5adapters.DetectDialect(tt.connStr)
		if got != tt.expected {
			t.Errorf("DetectDialect(%q) = %v, want %v", tt.connStr, got, tt.expected)
		}
	}
}

func TestSqliteQuoting(t *testing.T) {
	id := an5adapters.QuoteIdentifier("user_name", base.DialectSqlite)
	if id != `"user_name"` {
		t.Errorf("QuoteIdentifier() = %v, want %v", id, `"user_name"`)
	}

	tbl := an5adapters.QuoteTable("users", base.DialectSqlite)
	if tbl != `"users"` {
		t.Errorf("QuoteTable() = %v, want %v", tbl, `"users"`)
	}
}
