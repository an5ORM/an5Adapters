package base

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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
