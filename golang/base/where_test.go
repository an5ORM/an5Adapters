package base

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// SQLite is provided by Python's standard library to keep the adapter driver-neutral.
func TestSharedQueryContract(t *testing.T) {
	fixtures, err := os.ReadFile(filepath.Join("..", "..", "test", "fixtures", "query-semantics.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Rows  []map[string]interface{} `json:"rows"`
		Cases []struct {
			Name  string                 `json:"name"`
			Where map[string]interface{} `json:"where"`
			IDs   []int                  `json:"ids"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(fixtures, &contract); err != nil {
		t.Fatal(err)
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 is required for the SQLite query contract")
	}
	for _, c := range contract.Cases {
		t.Run(c.Name, func(t *testing.T) {
			clause, args := BuildWhere(c.Where, DialectSqlite, func(int) string { return "?" })
			payload, _ := json.Marshal(map[string]interface{}{"rows": contract.Rows, "clause": clause, "args": args})
			cmd := exec.Command(python, "-c", `import json,sqlite3,sys
p=json.loads(sys.argv[1])
db=sqlite3.connect(':memory:')
db.execute('CREATE TABLE users (id INTEGER, score INTEGER)')
db.executemany('INSERT INTO users VALUES (?,?)',[(r['id'],r['score']) for r in p['rows']])
sql='SELECT id FROM users'+(' WHERE '+p['clause'] if p['clause'] else '')+' ORDER BY id'
print(json.dumps([r[0] for r in db.execute(sql,p['args'])]))`, string(payload))
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("query failed: %v\n%s", err, output)
			}
			var got []int
			if err := json.Unmarshal(output, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.IDs) {
				t.Fatalf("got %v, want %v", got, c.IDs)
			}
		})
	}
}

func setupRelationTestMetadata() func() {
	SetAdapterMetadata(AdapterMetadata{
		ModelToTable: map[string]string{
			"User":      "dbo.users",
			"Order":     "dbo.orders",
			"OrderItem": "dbo.order_items",
			"Profile":   "dbo.profiles",
		},
		ModelFields: map[string]interface{}{
			"User":      map[string]interface{}{"id": true, "email": true, "created_at": true},
			"Order":     map[string]interface{}{"id": true, "user_id": true, "total": true, "status": true},
			"OrderItem": map[string]interface{}{"id": true, "order_id": true, "sku": true},
			"Profile":   map[string]interface{}{"id": true, "user_id": true, "bio": true},
		},
		RelationMap: map[string]map[string]RelationDef{
			"User": {
				"orders":  {ModelName: "Order", RelationType: "many", ForeignKey: "user_id", LocalKey: "id"},
				"profile": {ModelName: "Profile", RelationType: "one", ForeignKey: "user_id", LocalKey: "id"},
			},
			"Order": {
				"user":        {ModelName: "User", RelationType: "one", ForeignKey: "user_id", LocalKey: "id"},
				"order_items": {ModelName: "OrderItem", RelationType: "many", ForeignKey: "order_id", LocalKey: "id"},
			},
			"OrderItem": {
				"order": {ModelName: "Order", RelationType: "one", ForeignKey: "order_id", LocalKey: "id"},
			},
			"Profile": {
				"user": {ModelName: "User", RelationType: "one", ForeignKey: "user_id", LocalKey: "id"},
			},
		},
	})
	return func() {
		SetAdapterMetadata(AdapterMetadata{})
	}
}

func TestTryBuildWhereWithModelRelationsAndDialectSQL(t *testing.T) {
	defer setupRelationTestMetadata()()

	sqlitePh := func(int) string { return "?" }
	pgPh := func(n int) string { return fmt.Sprintf("$%d", n) }

	// Combined some + every uses distinct aliases and preserves nested scalar `not` alias qualification.
	clause, args, err := TryBuildWhereWithModel(map[string]interface{}{
		"orders": map[string]interface{}{
			"some":  map[string]interface{}{"status": map[string]interface{}{"not": map[string]interface{}{"equals": "cancelled"}}},
			"every": map[string]interface{}{"total": map[string]interface{}{"gte": 10}},
		},
	}, "User", DialectSqlite, sqlitePh)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(clause, `EXISTS (SELECT 1 FROM "orders" AS r_orders_some WHERE r_orders_some."user_id" = "users"."id" AND (NOT (r_orders_some."status" = ?)))`) {
		t.Fatalf("missing correlated some SQL with qualified NOT: %s", clause)
	}
	if !strings.Contains(clause, `NOT EXISTS (SELECT 1 FROM "orders" AS r_orders_every WHERE r_orders_every."user_id" = "users"."id" AND NOT (r_orders_every."total" >= ?))`) {
		t.Fatalf("missing correlated every SQL: %s", clause)
	}
	if len(args) != 2 || args[0] != "cancelled" || args[1] != 10 {
		t.Fatalf("unexpected args: %#v", args)
	}

	// FK-holding to-one relation Order.user with is_not alias and Postgres placeholders.
	pgClause, pgArgs, err := TryBuildWhereWithModel(map[string]interface{}{
		"user": map[string]interface{}{
			"is_not": map[string]interface{}{"email": map[string]interface{}{"contains": "spam", "mode": "insensitive"}},
		},
	}, "Order", DialectPostgres, pgPh)
	if err != nil {
		t.Fatalf("unexpected Postgres error: %v", err)
	}
	if !strings.Contains(pgClause, `NOT EXISTS (SELECT 1 FROM "dbo"."users" AS r_user_isNot WHERE r_user_isNot."id" = "dbo"."orders"."user_id" AND (LOWER(r_user_isNot."email") LIKE LOWER($1)))`) {
		t.Fatalf("unexpected Postgres to-one SQL: %s", pgClause)
	}
	if len(pgArgs) != 1 || pgArgs[0] != "%spam%" {
		t.Fatalf("unexpected Postgres args: %#v", pgArgs)
	}

	// Multi-hop relation User -> orders -> order_items (snake_case relation preserved by cleanWhere) on MSSQL.
	mssqlClause, mssqlArgs, err := TryBuildWhereWithModel(map[string]interface{}{
		"orders": map[string]interface{}{
			"some": map[string]interface{}{
				"order_items": map[string]interface{}{
					"some": map[string]interface{}{"sku": "AN5-PRO"},
				},
			},
		},
		"created_at": map[string]interface{}{"gte": "2026-01-01"},
		"user_compound": map[string]interface{}{
			"email": "alice@example.com",
		},
	}, "User", DialectMssql, sqlitePh)
	if err != nil {
		t.Fatalf("unexpected multi-hop error: %v", err)
	}
	if !strings.Contains(mssqlClause, `EXISTS (SELECT 1 FROM [dbo].[order_items] AS r_orders_some_order_items_some WHERE r_orders_some_order_items_some.[order_id] = r_orders_some.[id] AND (r_orders_some_order_items_some.[sku] = ?))`) {
		t.Fatalf("unexpected MSSQL multi-hop SQL: %s", mssqlClause)
	}
	if !strings.Contains(mssqlClause, `[created_at] >= ?`) || !strings.Contains(mssqlClause, `[email] = ?`) {
		t.Fatalf("cleanWhere failed to preserve created_at or flatten user_compound: %s", mssqlClause)
	}
	if len(mssqlArgs) != 3 {
		t.Fatalf("expected 3 args, got %d (%#v)", len(mssqlArgs), mssqlArgs)
	}
}

func TestTryBuildWhereWithModelStrictErrors(t *testing.T) {
	defer setupRelationTestMetadata()()
	ph := func(int) string { return "?" }

	cases := []struct {
		name  string
		model string
		where map[string]interface{}
	}{
		{"unknown scalar operator", "User", map[string]interface{}{"email": map[string]interface{}{"bogus": "x"}}},
		{"relation op on scalar", "User", map[string]interface{}{"email": map[string]interface{}{"some": map[string]interface{}{"id": 1}}}},
		{"mismatched to-one op on to-many", "User", map[string]interface{}{"orders": map[string]interface{}{"is": map[string]interface{}{"total": 1}}}},
		{"mismatched to-many op on to-one", "Order", map[string]interface{}{"user": map[string]interface{}{"some": map[string]interface{}{"email": "a"}}}},
		{"unknown relation op", "User", map[string]interface{}{"orders": map[string]interface{}{"any": map[string]interface{}{}}}},
		{"non-map relation value", "User", map[string]interface{}{"orders": "invalid"}},
		{"nil some relation filter", "User", map[string]interface{}{"orders": map[string]interface{}{"some": nil}}},
		{"non-map every relation filter", "User", map[string]interface{}{"orders": map[string]interface{}{"every": 42}}},
		{"invalid is value", "Order", map[string]interface{}{"user": map[string]interface{}{"is": 123}}},
		{"non-slice in operator", "User", map[string]interface{}{"email": map[string]interface{}{"in": "alice"}}},
		{"non-slice notIn operator", "User", map[string]interface{}{"email": map[string]interface{}{"notIn": 123}}},
		{"non-string contains", "User", map[string]interface{}{"email": map[string]interface{}{"contains": 99}}},
		{"invalid mode", "User", map[string]interface{}{"email": map[string]interface{}{"mode": "weird", "equals": "a"}}},
		{"unknown model field", "User", map[string]interface{}{"missing_col": "x"}},
		{"non-map AND entry", "User", map[string]interface{}{"AND": []interface{}{"bad"}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if clause, _, err := TryBuildWhereWithModel(tc.where, tc.model, DialectSqlite, ph); err == nil {
				t.Fatalf("expected error for %s, got clause %q", tc.name, clause)
			}
		})
	}
}

func TestSQLiteRelationFilterQueries(t *testing.T) {
	defer setupRelationTestMetadata()()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("python3 is required for SQLite relation tests")
	}

	runQuery := func(table, model string, where map[string]interface{}) []int {
		clause, args, buildErr := TryBuildWhereWithModel(where, model, DialectSqlite, func(int) string { return "?" })
		if buildErr != nil {
			t.Fatalf("TryBuildWhereWithModel(%s): %v", model, buildErr)
		}
		payload, _ := json.Marshal(map[string]interface{}{"table": table, "clause": clause, "args": args})
		cmd := exec.Command(python, "-c", `import json,sqlite3,sys
p=json.loads(sys.argv[1])
db=sqlite3.connect(':memory:')
db.executescript('''
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, created_at TEXT);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, user_id INTEGER, bio TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total INTEGER, status TEXT);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT);
INSERT INTO users VALUES (1,'alice@example.com','2026-01-01'),(2,'bob@example.com','2026-01-02'),(3,'carol@example.com','2026-01-03');
INSERT INTO profiles VALUES (10,1,'vip buyer'),(11,3,'new buyer');
INSERT INTO orders VALUES (100,1,150,'paid'),(101,1,60,'open'),(102,2,40,'cancelled'),(103,99,200,'paid');
INSERT INTO order_items VALUES (1000,100,'AN5-PRO'),(1001,102,'BASIC');
''')
sql='SELECT id FROM '+p['table']+(' WHERE '+p['clause'] if p['clause'] else '')+' ORDER BY id'
print(json.dumps([r[0] for r in db.execute(sql,p['args'])]))`, string(payload))
		out, execErr := cmd.CombinedOutput()
		if execErr != nil {
			t.Fatalf("sqlite execution failed (%s): %v\n%s\nclause=%s", model, execErr, out, clause)
		}
		var got []int
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("decode output: %v (%s)", err, out)
		}
		return got
	}

	assertIDs := func(name string, got, want []int) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %v, want %v", name, got, want)
		}
	}

	// Users: 1 has orders (150 paid, 60 open) + profile; 2 has order (40 cancelled) + no profile; 3 has no orders + profile.
	assertIDs("some paid >= 100", runQuery("users", "User", map[string]interface{}{
		"orders": map[string]interface{}{"some": map[string]interface{}{"status": "paid", "total": map[string]interface{}{"gte": 100}}},
	}), []int{1})

	assertIDs("none cancelled", runQuery("users", "User", map[string]interface{}{
		"orders": map[string]interface{}{"none": map[string]interface{}{"status": "cancelled"}},
	}), []int{1, 3})

	assertIDs("every total >= 50 (vacuously true for 3)", runQuery("users", "User", map[string]interface{}{
		"orders": map[string]interface{}{"every": map[string]interface{}{"total": map[string]interface{}{"gte": 50}}},
	}), []int{1, 3})

	assertIDs("combined some + every on orders", runQuery("users", "User", map[string]interface{}{
		"orders": map[string]interface{}{
			"some":  map[string]interface{}{"status": map[string]interface{}{"not": map[string]interface{}{"equals": "cancelled"}}},
			"every": map[string]interface{}{"total": map[string]interface{}{"gte": 50}},
		},
	}), []int{1})

	assertIDs("multi-hop orders.some.order_items.some", runQuery("users", "User", map[string]interface{}{
		"orders": map[string]interface{}{
			"some": map[string]interface{}{
				"order_items": map[string]interface{}{"some": map[string]interface{}{"sku": "AN5-PRO"}},
			},
		},
	}), []int{1})

	assertIDs("inverse 1-to-1 profile is vip", runQuery("users", "User", map[string]interface{}{
		"profile": map[string]interface{}{"is": map[string]interface{}{"bio": map[string]interface{}{"contains": "VIP", "mode": "insensitive"}}},
	}), []int{1})

	assertIDs("inverse 1-to-1 profile is nil", runQuery("users", "User", map[string]interface{}{
		"profile": map[string]interface{}{"is": nil},
	}), []int{2})

	assertIDs("inverse 1-to-1 profile isNot nil", runQuery("users", "User", map[string]interface{}{
		"profile": map[string]interface{}{"isNot": nil},
	}), []int{1, 3})

	// Orders: 100,101->user 1; 102->user 2; 103->orphan user 99.
	assertIDs("Order.user is alice", runQuery("orders", "Order", map[string]interface{}{
		"user": map[string]interface{}{"is": map[string]interface{}{"email": "alice@example.com"}},
	}), []int{100, 101})

	assertIDs("Order.user isNot alice (includes orphan 103)", runQuery("orders", "Order", map[string]interface{}{
		"user": map[string]interface{}{"is_not": map[string]interface{}{"email": "alice@example.com"}},
	}), []int{102, 103})

	assertIDs("Order.user is nil (orphan 103)", runQuery("orders", "Order", map[string]interface{}{
		"user": map[string]interface{}{"is": nil},
	}), []int{103})
}
