package an5adapters_test

import (
	"context"
	"database/sql"
	"math"
	"strings"
	"testing"

	an5adapters "an5adapters"
	"an5adapters/base"
	"an5adapters/sqlite"
)

// SQLite vector codec, strategy plan and ranking SQL.
//
// The adapter ships no SQLite driver, so these are unit tests: they pin the codec
// and the statements the search builds. That the statements are valid SQLite, and
// that they rank correctly, is covered end to end by the runtimes that do carry a
// driver — test/sqlite-vector.test.js (TypeScript), test/python/sqlite_vector.py
// (Python) and the .NET smoke. The package docstring in sqlite/vector.go is the
// shared specification every runtime implements.

var documentFields = map[string]interface{}{
	"id":        map[string]interface{}{"ts": "string", "sql": "TEXT", "isId": true},
	"title":     map[string]interface{}{"ts": "string", "sql": "TEXT"},
	"embedding": map[string]interface{}{"ts": "number[] | string", "sql": "VECTOR(3)"},
}

func TestVectorCodec(t *testing.T) {
	encoded := base.EncodeVector([]float64{1, -2, 0.5})
	if len(encoded) != 12 {
		t.Fatalf("EncodeVector length = %d, want 12 (float32 per value)", len(encoded))
	}
	// Little-endian float32: 1.0 is 0x3F800000.
	if encoded[0] != 0x00 || encoded[1] != 0x00 || encoded[2] != 0x80 || encoded[3] != 0x3F {
		t.Errorf("EncodeVector is not little-endian float32: %v", encoded[:4])
	}

	decoded := base.DecodeVector(encoded)
	if len(decoded) != 3 || decoded[0] != 1 || decoded[1] != -2 || decoded[2] != 0.5 {
		t.Errorf("DecodeVector(blob) = %v, want [1 -2 0.5]", decoded)
	}

	if got := base.DecodeVector("[1, 0, 0]"); len(got) != 3 || got[0] != 1 {
		t.Errorf("DecodeVector(legacy JSON text) = %v, want [1 0 0]", got)
	}
	if base.DecodeVector([]byte("[1, 0, 0]")) == nil {
		t.Error("JSON text delivered as bytes must still decode")
	}
	if base.DecodeVector([]byte{1, 2, 3}) != nil {
		t.Error("a partial blob must not decode")
	}
	if base.DecodeVector("not json") != nil {
		t.Error("text that is not JSON must not decode")
	}
	if base.DecodeVector(nil) != nil {
		t.Error("a null vector must stay null")
	}
	if got := base.DecodeVector([]float64{0.5, 1.5}); len(got) != 2 || got[1] != 1.5 {
		t.Errorf("DecodeVector(already decoded) = %v, want [0.5 1.5]", got)
	}
}

func TestNeedsVectorEncoding(t *testing.T) {
	cases := []struct {
		name  string
		value interface{}
		want  bool
	}{
		{"a float64 slice", []float64{1, 2}, true},
		{"a float32 slice", []float32{1, 2}, true},
		{"a generic slice", []interface{}{1.0, 2.0}, true},
		{"stored bytes", []byte{0, 0, 128, 63}, false},
		{"stored text", "[1,0,0]", false},
		{"nothing", nil, false},
		{"a scalar", 1.5, false},
	}
	for _, tc := range cases {
		if got := base.NeedsVectorEncoding(tc.value); got != tc.want {
			t.Errorf("NeedsVectorEncoding(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestVectorDistance(t *testing.T) {
	if got, ok := base.VectorDistance([]float64{1, 0}, []float64{1, 0}, "cosine"); !ok || math.Abs(got) > 1e-9 {
		t.Errorf("cosine of a vector with itself = %v (%v), want 0", got, ok)
	}
	if got, _ := base.VectorDistance([]float64{1, 0}, []float64{0, 1}, "cosine"); math.Abs(got-1) > 1e-9 {
		t.Errorf("cosine of orthogonal vectors = %v, want 1", got)
	}
	if got, _ := base.VectorDistance([]float64{0, 3}, []float64{4, 0}, "euclidean"); math.Abs(got-5) > 1e-9 {
		t.Errorf("euclidean distance = %v, want 5", got)
	}
	if got, _ := base.VectorDistance([]float64{1, 2}, []float64{2, 4}, "dot"); got != -10 {
		t.Errorf("dot distance is negated: got %v, want -10", got)
	}
	if _, ok := base.VectorDistance([]float64{1, 2}, []float64{1, 2, 3}, "cosine"); ok {
		t.Error("mismatched dimensions must not be scored")
	}
	if _, ok := base.VectorDistance(nil, []float64{1}, "cosine"); ok {
		t.Error("a missing vector must not be scored")
	}
	if got, _ := base.VectorDistance([]float64{0, 0}, []float64{1, 1}, "cosine"); got != 1 {
		t.Errorf("a zero vector is maximally distant: got %v, want 1", got)
	}
}

func TestIsVectorField(t *testing.T) {
	cases := []struct {
		name       string
		definition interface{}
		want       bool
	}{
		{"a VECTOR column", documentFields["embedding"], true},
		{"only a ts type", map[string]interface{}{"ts": "number[] | string"}, true},
		{"a kind marker", map[string]interface{}{"kind": "vector"}, true},
		{"a TEXT column", documentFields["title"], false},
		{"a bare string", "number[] | string", true},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		if got := base.IsVectorField(tc.definition); got != tc.want {
			t.Errorf("IsVectorField(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestPlanVectorStrategies(t *testing.T) {
	all := map[string]bool{"vec": true, "udf": true, "json1": true}
	if got := base.PlanVectorStrategies(all, "BLOB", ""); len(got) != 2 || got[0] != "sqlite-vec" || got[1] != "udf" {
		t.Errorf("a BLOB column must rank sqlite-vec then udf, got %v", got)
	}
	// A BLOB column has no JSON to read, so json_each could only produce NULLs.
	if got := base.PlanVectorStrategies(map[string]bool{"json1": true}, "BLOB", ""); len(got) != 0 {
		t.Errorf("a BLOB column drops the JSON strategy, got %v", got)
	}
	if got := base.PlanVectorStrategies(map[string]bool{"json1": true}, "TEXT", ""); len(got) != 1 || got[0] != "sql" {
		t.Errorf("a TEXT column keeps the JSON strategy, got %v", got)
	}
	if got := base.PlanVectorStrategies(map[string]bool{}, "TEXT", ""); len(got) != 0 {
		t.Errorf("no capability means no plan, got %v", got)
	}
	if got := base.PlanVectorStrategies(all, "BLOB", "udf"); len(got) != 1 || got[0] != "udf" {
		t.Errorf("a pinned strategy wins, got %v", got)
	}
	if got := base.PlanVectorStrategies(all, "BLOB", "memory"); len(got) != 0 {
		t.Errorf("memory is the caller's own path, not a query, got %v", got)
	}
}

func TestRankingQuery(t *testing.T) {
	tail := " WHERE [id] IN (?)"

	for _, tc := range []struct {
		strategy string
		want     []string
	}{
		{"sqlite-vec", []string{
			"vec_distance_cosine(",
            "vec_length(vec_f32([embedding])) = 3",
			// The guard carries the caller's WHERE, joined with AND rather than
			// appended as a second WHERE.
            "[embedding] IS NOT NULL AND " + tail[len(" WHERE "):],
			"an5_ranked",
			"WHERE distance IS NOT NULL",
		}},
		{"udf", []string{"an5_vec_cosine(", "an5_ranked", "WHERE distance IS NOT NULL", tail}},
		{"sql", []string{
			"WITH q AS (",
			"json_each(?) je",
			"json_valid([embedding])",
			"an5_ranked",
			"WHERE distance IS NOT NULL",
			tail,
		}},
	} {
		query, args := sqlite.BuildRankingQuery(tc.strategy, "cosine", "[documents]", "[embedding]", []float64{1, 0, 0}, 5, tail, nil)
		if query == "" {
			t.Fatalf("%s produced no query", tc.strategy)
		}
		for _, fragment := range tc.want {
			if !strings.Contains(query, fragment) {
				t.Errorf("%s query is missing %q:\n%s", tc.strategy, fragment, query)
			}
		}
		if !strings.Contains(query, "ORDER BY distance ASC LIMIT 5") {
			t.Errorf("%s query does not order and limit:\n%s", tc.strategy, query)
		}
		if len(args) == 0 {
			t.Errorf("%s query binds no query vector", tc.strategy)
		}
	}

	// The query vector is bound as float32 bytes for the two binary strategies and
	// as JSON text for the json_each one.
	_, blobArgs := sqlite.BuildRankingQuery("udf", "cosine", "[documents]", "[embedding]", []float64{1, 0, 0}, 5, "", nil)
	if encoded, ok := blobArgs[0].([]byte); !ok || len(encoded) != 12 {
		t.Errorf("udf query vector = %v, want 12 float32 bytes", blobArgs[0])
	}
	_, jsonArgs := sqlite.BuildRankingQuery("sql", "cosine", "[documents]", "[embedding]", []float64{1, 0, 0}, 5, "", nil)
	if text, ok := jsonArgs[0].(string); !ok || text != "[1,0,0]" {
		t.Errorf("sql query vector = %v, want the JSON text [1,0,0]", jsonArgs[0])
	}

	// Each metric calls its own function.
	for metric, fn := range map[string]string{
		"cosine":    "an5_vec_cosine(",
		"euclidean": "an5_vec_l2(",
		"dot":       "an5_vec_ip(",
	} {
		query, _ := sqlite.BuildRankingQuery("udf", metric, "[documents]", "[embedding]", []float64{1, 0}, 5, "", nil)
		if !strings.Contains(query, fn) {
			t.Errorf("%s query does not use %s:\n%s", metric, fn, query)
		}
	}

	// Exactly one WHERE per ranking query: the sqlite-vec guard and the caller's
	// clause are joined with AND, never appended as a second WHERE.
	guarded, _ := sqlite.BuildRankingQuery("sqlite-vec", "cosine", "[documents]", "[embedding]", []float64{1, 0}, 5, tail, nil)
	inner := guarded[strings.Index(guarded, "(")+1 : strings.Index(guarded, ") AS an5_ranked")]
	if strings.Count(inner, " WHERE ") != 1 {
		t.Errorf("the ranked subquery must carry exactly one WHERE:\n%s", inner)
	}

	// A WHERE clause is placed inside the ranking query, before the rank filter.
	query, _ := sqlite.BuildRankingQuery("udf", "cosine", "[documents]", "[embedding]", []float64{1, 0}, 5, " WHERE [id] = ?", nil)
	if strings.Index(query, "WHERE [id] = ?") > strings.Index(query, "an5_ranked") {
		t.Errorf("the caller's WHERE must stay inside the ranked subquery:\n%s", query)
	}
}

func TestNormalizeTableName(t *testing.T) {
	for input, want := range map[string]string{
		"documents":       "documents",
		"[documents]":     "documents",
		"`documents`":     "documents",
		`"documents"`:     "documents",
		"[main].[docs]":   "docs",
		"  [documents]  ": "documents",
	} {
		if got := sqlite.NormalizeTableName(input); got != want {
			t.Errorf("NormalizeTableName(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestVectorSearchFallbackRanksRows(t *testing.T) {
	// The in-memory fallback has to read every stored form of a vector: float32
	// bytes, the legacy JSON text column, and a slice the driver already decoded.
	rows := []map[string]interface{}{
		{"id": "d1", "embedding": base.EncodeVector([]float64{1, 0, 0})},
		{"id": "d2", "embedding": `[0.8,0.2,0]`},
		{"id": "d3", "embedding": []float64{0, 1, 0}},
		{"id": "d4", "embedding": base.EncodeVector([]float64{1, 0, 0, 1})},
		{"id": "d5", "embedding": nil},
	}

	ranked := an5adapters.VectorSearchFallback(rows, []float64{1, 0, 0}, 10, "embedding", "cosine")
	got := ""
	for i, row := range ranked {
		if i > 0 {
			got += ","
		}
		got += row["id"].(string)
	}
	if got != "d1,d2,d3" {
		t.Errorf("row order = %s, want d1,d2,d3", got)
	}
	if dist, ok := ranked[0]["distance"].(float64); !ok || math.Abs(dist) > 1e-9 {
		t.Errorf("closest distance = %v, want 0", ranked[0]["distance"])
	}
}

func TestCapabilitiesNeedsADatabase(t *testing.T) {
	// A nil handle has to report no capability rather than panic, so the caller
	// falls through to the in-memory path.
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("Capabilities panicked on a closed handle: %v", recovered)
		}
	}()
	caps := sqlite.Capabilities(context.Background(), (*sql.DB)(nil))
	if caps["vec"] || caps["udf"] || caps["json1"] {
		t.Errorf("Capabilities on no database = %v, want all false", caps)
	}
}
