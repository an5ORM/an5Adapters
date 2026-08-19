// Package base provides dialect-aware WHERE and ORDER BY builders for the AN5 Go adapter.
package base

import (
	"fmt"
	"sort"
	"strings"
)

// operatorKeys are the supported comparison operators inside a filter object.
var operatorKeys = []string{"equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt"}

// isOperatorMap reports whether v is a filter dictionary containing ORM operators.
func isOperatorMap(v interface{}) bool {
	m, ok := v.(map[string]interface{})
	if !ok {
		return false
	}
	for _, op := range operatorKeys {
		if _, has := m[op]; has {
			return true
		}
	}
	return false
}

// isPlainMap reports whether v is a non-nil map.
func isPlainMap(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	if !ok || m == nil {
		return nil, false
	}
	return m, true
}

// cleanWhere flattens relation-style nested where objects (key contains '_' with a plain-map value).
func cleanWhere(where map[string]interface{}) map[string]interface{} {
	clean := map[string]interface{}{}
	for k, v := range where {
		if strings.Contains(k, "_") {
			if m, ok := isPlainMap(v); ok && !isOperatorMap(v) {
				for nk, nv := range m {
					clean[nk] = nv
				}
			} else {
				clean[k] = v
			}
		} else {
			clean[k] = v
		}
	}
	return clean
}

// sortedKeys returns the map keys in a stable sorted order for deterministic SQL.
func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// BuildWhere converts an ORM-style where object into a SQL clause with ordered placeholders.
// ph returns the placeholder for arg position n (1-based).
func BuildWhere(where map[string]interface{}, dialect Dialect, ph func(n int) string) (string, []interface{}) {
	args := make([]interface{}, 0, 8)
	clause := buildWhereRec(cleanWhere(where), dialect, &args, ph, "")
	return clause, args
}

func buildWhereRec(where map[string]interface{}, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string) string {
	if where == nil || len(where) == 0 {
		return ""
	}
	var conditions []string

	for _, key := range sortedKeys(where) {
		value := where[key]

		switch key {
		case "OR":
			if list, ok := toSlice(value); ok && len(list) > 0 {
				var subs []string
				for i, item := range list {
					if m, ok := item.(map[string]interface{}); ok && m != nil {
						if s := buildWhereRec(m, dialect, args, ph, fmt.Sprintf("%sor%d_", prefix, i)); s != "" {
							subs = append(subs, s)
						}
					}
				}
				if len(subs) > 0 {
					conditions = append(conditions, "("+strings.Join(subs, " OR ")+")")
				}
				continue
			}
		case "AND":
			if list, ok := toSlice(value); ok && len(list) > 0 {
				var subs []string
				for i, item := range list {
					if m, ok := item.(map[string]interface{}); ok && m != nil {
						if s := buildWhereRec(m, dialect, args, ph, fmt.Sprintf("%sand%d_", prefix, i)); s != "" {
							subs = append(subs, s)
						}
					}
				}
				if len(subs) > 0 {
					conditions = append(conditions, "("+strings.Join(subs, " AND ")+")")
				}
				continue
			}
		case "NOT":
			items := value
			if m, ok := value.(map[string]interface{}); ok {
				items = []interface{}{m}
			}
			if list, ok := toSlice(items); ok && len(list) > 0 {
				var subs []string
				for i, item := range list {
					if m, ok := item.(map[string]interface{}); ok && m != nil {
						if s := buildWhereRec(m, dialect, args, ph, fmt.Sprintf("%snot%d_", prefix, i)); s != "" {
							subs = append(subs, s)
						}
					}
				}
				if len(subs) > 0 {
					conditions = append(conditions, "NOT ("+strings.Join(subs, " AND ")+")")
				}
				continue
			}
		}

		conditions = append(conditions, buildFieldCondition(key, value, dialect, args, ph, prefix)...)
	}

	return strings.Join(conditions, " AND ")
}

func buildFieldCondition(key string, value interface{}, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string) []string {
	col := QuoteIdentifier(key, dialect)

	if value == nil {
		return []string{col + " IS NULL"}
	}

	m, isMap := isPlainMap(value)
	if !isMap {
		n := len(*args) + 1
		*args = append(*args, value)
		return []string{fmt.Sprintf("%s = %s", col, ph(n))}
	}

	var parts []string
	addArg := func(val interface{}) string {
		n := len(*args) + 1
		*args = append(*args, val)
		return ph(n)
	}

	// Determine property order deterministically.
	var opKeys []string
	for k := range m {
		opKeys = append(opKeys, k)
	}
	sort.Strings(opKeys)

	for _, op := range opKeys {
		val := m[op]
		switch op {
		case "not":
			if val == nil {
				parts = append(parts, col+" IS NOT NULL")
			} else if nested, ok := val.(map[string]interface{}); ok && !isOperatorMap(val) {
				if nestedArgs := len(*args); true {
					nestedCond := buildWhereRec(map[string]interface{}{key: nested}, dialect, args, ph, key+"_not_")
					_ = nestedArgs
					if nestedCond != "" {
						parts = append(parts, "NOT ("+nestedCond+")")
					}
				}
			} else {
				parts = append(parts, fmt.Sprintf("%s <> %s", col, addArg(val)))
			}
		case "equals":
			if val == nil {
				parts = append(parts, col+" IS NULL")
			} else {
				parts = append(parts, fmt.Sprintf("%s = %s", col, addArg(val)))
			}
		case "contains":
			parts = append(parts, fmt.Sprintf("%s LIKE %s", col, addArg("%"+toString(val)+"%")))
		case "startsWith":
			parts = append(parts, fmt.Sprintf("%s LIKE %s", col, addArg(toString(val)+"%")))
		case "endsWith":
			parts = append(parts, fmt.Sprintf("%s LIKE %s", col, addArg("%"+toString(val))))
		case "gte":
			parts = append(parts, fmt.Sprintf("%s >= %s", col, addArg(val)))
		case "lte":
			parts = append(parts, fmt.Sprintf("%s <= %s", col, addArg(val)))
		case "gt":
			parts = append(parts, fmt.Sprintf("%s > %s", col, addArg(val)))
		case "lt":
			parts = append(parts, fmt.Sprintf("%s < %s", col, addArg(val)))
		case "in":
			if list, ok := toSlice(val); ok && len(list) > 0 {
				var phs []string
				for _, item := range list {
					phs = append(phs, addArg(item))
				}
				parts = append(parts, fmt.Sprintf("%s IN (%s)", col, strings.Join(phs, ", ")))
			} else {
				parts = append(parts, "1=0")
			}
		case "notIn":
			if list, ok := toSlice(val); ok && len(list) > 0 {
				var phs []string
				for _, item := range list {
					phs = append(phs, addArg(item))
				}
				parts = append(parts, fmt.Sprintf("%s NOT IN (%s)", col, strings.Join(phs, ", ")))
			} else {
				parts = append(parts, "1=1")
			}
		}
	}
	return parts
}

// toSlice attempts to interpret value as []interface{} (also accepting []string and []int).
func toSlice(value interface{}) ([]interface{}, bool) {
	switch v := value.(type) {
	case []interface{}:
		return v, true
	case []string:
		out := make([]interface{}, len(v))
		for i, s := range v {
			out[i] = s
		}
		return out, true
	case []int:
		out := make([]interface{}, len(v))
		for i, s := range v {
			out[i] = s
		}
		return out, true
	case []float64:
		out := make([]interface{}, len(v))
		for i, s := range v {
			out[i] = s
		}
		return out, true
	default:
		return nil, false
	}
}

func toString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

// normalizeSortDirection normalizes a direction to ASC or DESC.
func normalizeSortDirection(dir interface{}) string {
	if s, ok := dir.(string); ok && strings.EqualFold(s, "DESC") {
		return "DESC"
	}
	return "ASC"
}

// BuildOrderBy converts an ORM-style orderBy object (map or list of maps) into a SQL ORDER BY clause.
// Supports map[string]string, map[string]interface{}, []interface{} and a plain string.
func BuildOrderBy(orderBy interface{}, dialect Dialect) string {
	var entries []map[string]interface{}

	switch v := orderBy.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return ""
		}
		return "ORDER BY " + v
	case []interface{}:
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				entries = append(entries, m)
			}
		}
	case []map[string]interface{}:
		entries = v
	case map[string]interface{}:
		entries = []map[string]interface{}{v}
	default:
		return ""
	}

	if len(entries) == 0 {
		return ""
	}
	var parts []string
	for _, entry := range entries {
		for _, key := range sortedKeys(entry) {
			parts = append(parts, fmt.Sprintf("%s %s", QuoteIdentifier(key, dialect), normalizeSortDirection(entry[key])))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "ORDER BY " + strings.Join(parts, ", ")
}