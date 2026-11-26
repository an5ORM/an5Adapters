package an5adapters_test

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"

	an5adapters "an5adapters"
	"an5adapters/base"
)

type recordedQuery struct {
	sql  string
	args []interface{}
}

type recordingDriverState struct {
	mu      sync.Mutex
	queries []recordedQuery
	execs   []recordedQuery
	queryFn func(query string, args []driver.NamedValue) (cols []string, rows [][]driver.Value)
}

var mockDriverStates = map[string]*recordingDriverState{}
var mockDriverOnce sync.Once

type mockSQLDriver struct{}

func (d *mockSQLDriver) Open(name string) (driver.Conn, error) {
	return &mockConn{stateKey: name}, nil
}

type mockConn struct {
	stateKey string
}

func (c *mockConn) state() *recordingDriverState {
	return mockDriverStates[c.stateKey]
}

func (c *mockConn) Prepare(query string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockConn) Close() error                              { return nil }
func (c *mockConn) Begin() (driver.Tx, error)                 { return &mockTx{}, nil }

func (c *mockConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	st := c.state()
	vals := make([]interface{}, len(args))
	for i, a := range args {
		vals[i] = a.Value
	}
	st.mu.Lock()
	st.queries = append(st.queries, recordedQuery{sql: query, args: vals})
	fn := st.queryFn
	st.mu.Unlock()
	if fn != nil {
		cols, rows := fn(query, args)
		return &mockRows{cols: cols, rows: rows}, nil
	}
	return &mockRows{cols: []string{"id"}, rows: nil}, nil
}

func (c *mockConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	st := c.state()
	vals := make([]interface{}, len(args))
	for i, a := range args {
		vals[i] = a.Value
	}
	st.mu.Lock()
	st.execs = append(st.execs, recordedQuery{sql: query, args: vals})
	st.mu.Unlock()
	return driver.RowsAffected(1), nil
}

type mockTx struct{}

func (t *mockTx) Commit() error   { return nil }
func (t *mockTx) Rollback() error { return nil }

type mockRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *mockRows) Columns() []string { return r.cols }
func (r *mockRows) Close() error      { return nil }
func (r *mockRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

func openMockAdapter(t *testing.T, key, dsn string, fn func(string, []driver.NamedValue) ([]string, [][]driver.Value)) (*an5adapters.An5Adapter, *recordingDriverState) {
	t.Helper()
	mockDriverOnce.Do(func() {
		sql.Register("an5mock", &mockSQLDriver{})
	})
	st := &recordingDriverState{queryFn: fn}
	mockDriverStates[key] = st
	db, err := sql.Open("an5mock", key)
	if err != nil {
		t.Fatalf("sql.Open(an5mock): %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
		delete(mockDriverStates, key)
	})
	return &an5adapters.An5Adapter{
		DB:      db,
		Dialect: an5adapters.DetectDialect(dsn),
	}, st
}

func registerSampleRelationMetadata() func() {
	an5adapters.SetAdapterMetadata(an5adapters.AdapterMetadata{
		ModelToTable: map[string]string{
			"User":    "dbo.users",
			"Order":   "dbo.orders",
			"Profile": "dbo.profiles",
		},
		ModelFields: map[string]interface{}{
			"User":    map[string]interface{}{"id": true, "email": true, "name": true},
			"Order":   map[string]interface{}{"id": true, "user_id": true, "total": true, "status": true},
			"Profile": map[string]interface{}{"id": true, "user_id": true, "bio": true},
		},
		RelationMap: map[string]map[string]an5adapters.RelationDef{
			"User": {
				"orders":  {ModelName: "Order", RelationType: "many", ForeignKey: "user_id", LocalKey: "id"},
				"profile": {ModelName: "Profile", RelationType: "one", ForeignKey: "user_id", LocalKey: "id"},
			},
			"Order": {
				"user": {ModelName: "User", RelationType: "one", ForeignKey: "user_id", LocalKey: "id"},
			},
			"Profile": {
				"user": {ModelName: "User", RelationType: "one", ForeignKey: "user_id", LocalKey: "id"},
			},
		},
	})
	return func() {
		an5adapters.SetAdapterMetadata(an5adapters.AdapterMetadata{})
	}
}

func TestResolveRelationKeysCoverage(t *testing.T) {
	defer registerSampleRelationMetadata()()

	if childCol, parentCol := an5adapters.ResolveRelationKeys("User", an5adapters.RelationDef{
		ModelName: "Order", RelationType: "many", ForeignKey: "user_id", LocalKey: "id",
	}); childCol != "user_id" || parentCol != "id" {
		t.Fatalf("User.orders = (%s, %s), want (user_id, id)", childCol, parentCol)
	}

	if childCol, parentCol := an5adapters.ResolveRelationKeys("Order", an5adapters.RelationDef{
		ModelName: "User", RelationType: "one", ForeignKey: "user_id", LocalKey: "id",
	}); childCol != "id" || parentCol != "user_id" {
		t.Fatalf("Order.user = (%s, %s), want (id, user_id)", childCol, parentCol)
	}

	// Inverse 1-to-1: FK lives on child Profile, PK id lives on parent User.
	if childCol, parentCol := an5adapters.ResolveRelationKeys("User", an5adapters.RelationDef{
		ModelName: "Profile", RelationType: "one", ForeignKey: "user_id", LocalKey: "id",
	}); childCol != "user_id" || parentCol != "id" {
		t.Fatalf("User.profile inverse 1-to-1 = (%s, %s), want (user_id, id)", childCol, parentCol)
	}
}

func TestTableClientRejectsInvalidWhereBeforeExecution(t *testing.T) {
	defer registerSampleRelationMetadata()()
	ctx := context.Background()
	adapter, st := openMockAdapter(t, "invalid-where", "sqlite://test.db", nil)
	users := adapter.Table("User")

	invalidWheres := []struct {
		name  string
		where interface{}
	}{
		{"unknown scalar op", map[string]interface{}{"email": map[string]interface{}{"bogus": "x"}}},
		{"relation op on scalar", map[string]interface{}{"email": map[string]interface{}{"some": map[string]interface{}{"id": "1"}}}},
		{"mismatched relation op on many", map[string]interface{}{"orders": map[string]interface{}{"is": map[string]interface{}{"status": "paid"}}}},
		{"unknown field on model", map[string]interface{}{"nonexistentCol": "x"}},
		{"non-slice in operator", map[string]interface{}{"email": map[string]interface{}{"in": "not-a-slice"}}},
		{"non-map where", "raw-invalid"},
	}

	for _, tc := range invalidWheres {
		if _, err := users.FindMany(ctx, &an5adapters.FindManyArgs{Where: tc.where}); err == nil {
			t.Errorf("FindMany(%s) succeeded, want validation error", tc.name)
		}
		if _, err := users.Count(ctx, &an5adapters.CountArgs{Where: tc.where}); err == nil {
			t.Errorf("Count(%s) succeeded, want validation error", tc.name)
		}
		if _, err := users.UpdateMany(ctx, &an5adapters.UpdateManyArgs{Where: tc.where, Data: map[string]interface{}{"name": "x"}}); err == nil {
			t.Errorf("UpdateMany(%s) succeeded, want validation error", tc.name)
		}
		if _, err := users.DeleteMany(ctx, &an5adapters.DeleteManyArgs{Where: tc.where}); err == nil {
			t.Errorf("DeleteMany(%s) succeeded, want validation error", tc.name)
		}
		if _, err := users.Aggregate(ctx, &an5adapters.AggregateArgs{Where: tc.where, Count: true}); err == nil {
			t.Errorf("Aggregate(%s) succeeded, want validation error", tc.name)
		}
		if _, err := users.GroupBy(ctx, &an5adapters.GroupByArgs{By: []string{"email"}, Where: tc.where}); err == nil {
			t.Errorf("GroupBy(%s) succeeded, want validation error", tc.name)
		}
	}

	if len(st.queries) != 0 || len(st.execs) != 0 {
		t.Fatalf("validation failures should not execute SQL, got queries=%d execs=%d", len(st.queries), len(st.execs))
	}
}

func TestTableClientInverseOneToOneIncludeAndPostgresUpdateOffsets(t *testing.T) {
	defer registerSampleRelationMetadata()()
	ctx := context.Background()

	// 1. SQLite include for inverse 1-to-1 relation User.profile + dbo stripping.
	sqliteAdapter, sqliteState := openMockAdapter(t, "include-sqlite", "sqlite://test.db", func(query string, _ []driver.NamedValue) ([]string, [][]driver.Value) {
		if strings.Contains(query, `"users"`) {
			return []string{"id", "email"}, [][]driver.Value{{"u1", "a@example.com"}}
		}
		if strings.Contains(query, `"profiles"`) {
			return []string{"id", "user_id", "bio"}, [][]driver.Value{{"p1", "u1", "hello"}}
		}
		return []string{"id"}, nil
	})
	rows, err := sqliteAdapter.Table("User").FindMany(ctx, &an5adapters.FindManyArgs{
		Where: map[string]interface{}{
			"profile": map[string]interface{}{
				"is": map[string]interface{}{"bio": "hello"},
			},
		},
		Include: map[string]interface{}{"profile": true},
	})
	if err != nil {
		t.Fatalf("FindMany with inverse 1-to-1 include failed: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 user row, got %d", len(rows))
	}
	prof, ok := rows[0]["profile"].(map[string]interface{})
	if !ok || prof["bio"] != "hello" {
		t.Fatalf("expected attached inverse 1-to-1 profile, got %#v", rows[0]["profile"])
	}
	if len(sqliteState.queries) < 2 {
		t.Fatalf("expected parent and include queries, got %d", len(sqliteState.queries))
	}
	if strings.Contains(sqliteState.queries[0].sql, "dbo") {
		t.Fatalf("SQLite query must strip dbo prefix: %s", sqliteState.queries[0].sql)
	}
	if !strings.Contains(sqliteState.queries[0].sql, `EXISTS (SELECT 1 FROM "profiles" AS r_profile_is WHERE r_profile_is."user_id" = "users"."id"`) {
		t.Fatalf("unexpected inverse 1-to-1 EXISTS SQL: %s", sqliteState.queries[0].sql)
	}
	if !strings.Contains(sqliteState.queries[1].sql, `"user_id" IN (`) {
		t.Fatalf("include query should match on profile.user_id: %s", sqliteState.queries[1].sql)
	}

	// 2. Postgres UpdateMany placeholder offsets ($1 in SET, $2 in WHERE).
	pgAdapter, pgState := openMockAdapter(t, "pg-update", "postgres://localhost/test", nil)
	if _, err := pgAdapter.Table("User").UpdateMany(ctx, &an5adapters.UpdateManyArgs{
		Data:  map[string]interface{}{"name": "Updated"},
		Where: map[string]interface{}{"email": "a@example.com"},
	}); err != nil {
		t.Fatalf("Postgres UpdateMany failed: %v", err)
	}
	if len(pgState.execs) != 1 {
		t.Fatalf("expected 1 exec, got %d", len(pgState.execs))
	}
	pgSQL := pgState.execs[0].sql
	if !strings.Contains(pgSQL, `SET "name" = $1`) || !strings.Contains(pgSQL, `WHERE "email" = $2`) {
		t.Fatalf("unexpected Postgres placeholder numbering: %s", pgSQL)
	}

	// 3. Base dialect helper smoke check.
	if base.ToSnakeCase("UserID") != "user_id" {
		t.Fatalf("ToSnakeCase(UserID) = %q, want user_id", base.ToSnakeCase("UserID"))
	}
}

func TestTableClientGroupByHavingPerFieldCountAndPagination(t *testing.T) {
	defer registerSampleRelationMetadata()()
	ctx := context.Background()

	// 1. Postgres GroupBy with Where + Having sequential placeholders, per-field count, and reshaping.
	pgAdapter, pgState := openMockAdapter(t, "pg-groupby", "postgres://localhost/test", func(query string, _ []driver.NamedValue) ([]string, [][]driver.Value) {
		return []string{"status", "_count", "cnt_user_id", "sum_total"}, [][]driver.Value{
			{"paid", int64(3), int64(2), int64(500)},
		}
	})
	grouped, err := pgAdapter.Table("Order").GroupBy(ctx, &an5adapters.GroupByArgs{
		By:     []string{"status"},
		Where:  map[string]interface{}{"total": map[string]interface{}{"gte": 10}},
		Having: map[string]interface{}{"_sum": map[string]interface{}{"total": map[string]interface{}{"gt": 100}}, "status": "paid"},
		Count:  map[string]bool{"_all": true, "user_id": true},
		Sum:    []string{"total"},
		Skip:   1,
	})
	if err != nil {
		t.Fatalf("Postgres GroupBy failed: %v", err)
	}
	if len(pgState.queries) != 1 {
		t.Fatalf("expected 1 Postgres query, got %d", len(pgState.queries))
	}
	pgQuery := pgState.queries[0]
	wantSQL := `SELECT "status", COUNT(*) AS _count, COUNT("user_id") AS cnt_user_id, SUM("total") AS sum_total FROM "dbo"."orders" WHERE "total" >= $1 GROUP BY "status" HAVING SUM("total") > $2 AND "status" = $3 ORDER BY "status" LIMIT ALL OFFSET 1`
	if pgQuery.sql != wantSQL {
		t.Fatalf("Postgres GroupBy SQL:\n got: %s\nwant: %s", pgQuery.sql, wantSQL)
	}
	if len(pgQuery.args) != 3 || pgQuery.args[0] != int64(10) || pgQuery.args[1] != int64(100) || pgQuery.args[2] != "paid" {
		t.Fatalf("unexpected Postgres GroupBy args: %#v", pgQuery.args)
	}
	if len(grouped) != 1 {
		t.Fatalf("expected 1 grouped row, got %d", len(grouped))
	}
	cntMap, ok := grouped[0]["_count"].(map[string]interface{})
	if !ok || cntMap["_all"] != float64(3) || cntMap["user_id"] != float64(2) {
		t.Fatalf("unexpected reshaped _count: %#v", grouped[0]["_count"])
	}
	sumMap, ok := grouped[0]["_sum"].(map[string]interface{})
	if !ok || sumMap["total"] != float64(500) {
		t.Fatalf("unexpected reshaped _sum: %#v", grouped[0]["_sum"])
	}

	// 2. SQLite offset-only pagination emits LIMIT -1 OFFSET 1 in both FindMany and GroupBy.
	sqliteAdapter, sqliteState := openMockAdapter(t, "sqlite-offset", "sqlite://test.db", nil)
	if _, err := sqliteAdapter.Table("Order").FindMany(ctx, &an5adapters.FindManyArgs{Skip: 2}); err != nil {
		t.Fatalf("SQLite FindMany offset-only failed: %v", err)
	}
	if _, err := sqliteAdapter.Table("Order").GroupBy(ctx, &an5adapters.GroupByArgs{By: []string{"status"}, Skip: 1}); err != nil {
		t.Fatalf("SQLite GroupBy offset-only failed: %v", err)
	}
	if !strings.Contains(sqliteState.queries[0].sql, "LIMIT -1 OFFSET 2") {
		t.Fatalf("SQLite FindMany must emit LIMIT -1 OFFSET 2, got: %s", sqliteState.queries[0].sql)
	}
	if !strings.Contains(sqliteState.queries[1].sql, "LIMIT -1 OFFSET 1") {
		t.Fatalf("SQLite GroupBy must emit LIMIT -1 OFFSET 1, got: %s", sqliteState.queries[1].sql)
	}

	// 3. Invalid HAVING clause must fail before querying DB.
	if _, err := sqliteAdapter.Table("Order").GroupBy(ctx, &an5adapters.GroupByArgs{
		By:     []string{"status"},
		Having: map[string]interface{}{"total": map[string]interface{}{"gt": 10}},
	}); err == nil {
		t.Fatal("expected GroupBy error for ungrouped scalar field in Having")
	}
}
