package base

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
)

// ─── SQLite vector codec ──────────────────────────────────────────────────────────
//
// SQLite has no vector type, so a `VECTOR(n)` column stores a BLOB of little-endian
// float32 values. These helpers are shared by the adapter (which reads and writes
// the column) and by the `sqlite` package (which builds the ranking SQL).
//
// BytesPerVectorFloat is the size of one stored value; the column length in bytes
// is the dimension times this, which is what the sqlite-vec strategy filters on.
const BytesPerVectorFloat = 4

// Vector field kinds the generated clients can describe.
const (
	VectorStrategySqliteVec = "sqlite-vec"
	VectorStrategyUdf       = "udf"
	VectorStrategySQL       = "sql"
	VectorStrategyMemory    = "memory"
)

// An5VectorFunctions are the scalar functions the driver may register so SQLite
// itself ranks the column.
var An5VectorFunctions = map[string]string{
	"cosine":    "an5_vec_cosine",
	"euclidean": "an5_vec_l2",
	"dot":       "an5_vec_ip",
}

// SqliteVecFunctions are the scalar functions the sqlite-vec extension provides.
var SqliteVecFunctions = map[string]string{
	"cosine":    "vec_distance_cosine",
	"euclidean": "vec_distance_l2",
	"dot":       "vec_distance_ip",
}

// EncodeVector encodes a vector as the little-endian float32 BLOB the column stores.
func EncodeVector(values []float64) []byte {
	bytes := make([]byte, len(values)*BytesPerVectorFloat)
	for i, v := range values {
		binary.LittleEndian.PutUint32(bytes[i*BytesPerVectorFloat:], math.Float32bits(float32(v)))
	}
	return bytes
}

// ParseVector reads a numeric sequence, or JSON text holding one.
func ParseVector(value interface{}) []float64 {
	switch v := value.(type) {
	case nil:
		return nil
	case []float64:
		return v
	case float32:
		return []float64{float64(v)}
	case float64:
		return []float64{v}
	case []float32:
		out := make([]float64, len(v))
		for i, f := range v {
			out[i] = float64(f)
		}
		return out
	case string:
		trimmed := strings.TrimSpace(v)
		if !strings.HasPrefix(trimmed, "[") {
			return nil
		}
		var parsed []float64
		if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
			return nil
		}
		return ParseVector(parsed)
	case []byte:
		// `database/sql` hands a BLOB column over as bytes; whether that is
		// float32 storage or JSON text is decided by its length and first byte.
		if len(v) > 0 && v[0] == '[' {
			var parsed []float64
			if err := json.Unmarshal(v, &parsed); err != nil {
				return nil
			}
			return ParseVector(parsed)
		}
		return DecodeVector(v)
	case []interface{}:
		out := make([]float64, 0, len(v))
		for _, item := range v {
			f, ok := item.(float64)
			if !ok {
				return nil
			}
			out = append(out, f)
		}
		return out
	default:
		return nil
	}
}

// DecodeVector decodes a stored vector: a float32 BLOB, a legacy JSON text
// column, or a sequence the driver already decoded.
func DecodeVector(value interface{}) []float64 {
	if bytes, ok := value.([]byte); ok {
		if len(bytes) == 0 || len(bytes)%BytesPerVectorFloat != 0 {
			// Not float32 storage; it may still be JSON text in the same column.
			return ParseVector(string(bytes))
		}
		if len(bytes) > 0 && bytes[0] == '[' {
			return nil
		}
		out := make([]float64, len(bytes)/BytesPerVectorFloat)
		for i := range out {
			out[i] = float64(math.Float32frombits(binary.LittleEndian.Uint32(bytes[i*BytesPerVectorFloat:])))
		}
		return out
	}
	return ParseVector(value)
}

// NeedsVectorEncoding reports whether a value still has to become bytes on its
// way into a `VECTOR(n)` column. `[]float64` and `[]interface{}` are the shapes
// a caller writes; text and bytes are already stored forms and pass through.
func NeedsVectorEncoding(value interface{}) bool {
	switch value.(type) {
	case nil, string, []byte:
		return false
	case []float64, []float32:
		return true
	case []interface{}:
		return len(value.([]interface{})) > 0
	default:
		return false
	}
}

// IsVectorField reports whether generated metadata describes a `VECTOR(n)` column.
// The metadata value is a map of field name to a small record, so both a typed
// struct and a plain map are accepted.
func IsVectorField(definition interface{}) bool {
	switch def := definition.(type) {
	case nil:
		return false
	case string:
		return strings.Contains(def, "[]") || strings.HasPrefix(strings.ToUpper(strings.TrimSpace(def)), "VECTOR")
	case map[string]interface{}:
		if kind, _ := def["kind"].(string); kind == "vector" {
			return true
		}
		for _, key := range []string{"sql", "type"} {
			if sql, ok := def[key].(string); ok && sqlLooksVector(sql) {
				return true
			}
		}
		ts, _ := def["ts"].(string)
		return strings.Contains(ts, "[]")
	default:
		return false
	}
}

// sqlLooksVector reports whether a declared SQL type names a vector column.
func sqlLooksVector(sql string) bool {
	trimmed := strings.ToUpper(strings.TrimSpace(sql))
	if !strings.HasPrefix(trimmed, "VECTOR") {
		return false
	}
	rest := trimmed[len("VECTOR"):]
	return rest == "" || strings.HasPrefix(rest, "(") || strings.HasPrefix(rest, " ")
}

// PlanVectorStrategies returns the ordered strategies to try for a connection.
//
// capabilities reports what the connection supports; declaredType is the
// column's DDL type, because the JSON strategy only reaches rows stored as text
// and so a BLOB column drops it from the order. preference pins one strategy.
func PlanVectorStrategies(capabilities map[string]bool, declaredType, preference string) []string {
	if preference != "" && preference != "auto" {
		if preference == VectorStrategyMemory {
			return nil
		}
		return []string{preference}
	}

	var available []string
	if capabilities["vec"] {
		available = append(available, VectorStrategySqliteVec)
	}
	if capabilities["udf"] {
		available = append(available, VectorStrategyUdf)
	}
	if capabilities["json1"] {
		available = append(available, VectorStrategySQL)
	}

	declared := strings.ToUpper(strings.TrimSpace(declaredType))
	if declared != "" && !strings.Contains(declared, "TEXT") && !strings.Contains(declared, "CHAR") &&
		!strings.Contains(declared, "CLOB") && !strings.Contains(declared, "STRING") &&
		!strings.Contains(declared, "JSON") {
		return without(available, VectorStrategySQL)
	}
	return available
}

func without(list []string, item string) []string {
	out := make([]string, 0, len(list))
	for _, entry := range list {
		if entry != item {
			out = append(out, entry)
		}
	}
	return out
}

// NormalizeMetric returns a known metric name, defaulting to cosine.
func NormalizeMetric(metric string) string {
	switch strings.ToLower(strings.TrimSpace(metric)) {
	case "euclidean", "dot":
		return strings.ToLower(strings.TrimSpace(metric))
	default:
		return "cosine"
	}
}

// VectorDistance returns the distance between two equal-length vectors, lower is
// closer. It mirrors the SQL functions so a search ranks the same way whichever
// strategy ran. The second result is false when the pair cannot be scored, which
// is how a stored vector of another dimension is kept out of the ranking.
func VectorDistance(a, b []float64, metric string) (float64, bool) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, false
	}
	switch NormalizeMetric(metric) {
	case "euclidean":
		return EuclideanDistance(a, b), true
	case "dot":
		return -DotProduct(a, b), true
	default:
		m1 := math.Sqrt(sumOfSquares(a))
		m2 := math.Sqrt(sumOfSquares(b))
		if m1 == 0 || m2 == 0 {
			return 1.0, true
		}
		var dot float64
		for i := range a {
			dot += a[i] * b[i]
		}
		return 1.0 - dot/(m1*m2), true
	}
}

func sumOfSquares(values []float64) float64 {
	var sum float64
	for _, v := range values {
		sum += v * v
	}
	return sum
}
