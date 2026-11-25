// Package base provides dialect-aware WHERE and ORDER BY builders for the AN5 Go adapter.
package base

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// operatorKeys are the supported comparison operators inside a filter object.
var operatorKeys = []string{"equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt", "mode"}

var relationOperatorKeys = map[string]bool{
	"some":   true,
	"none":   true,
	"every":  true,
	"is":     true,
	"isNot":  true,
	"is_not": true,
}

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

// isRelationOperatorMap reports whether v is a relation filter dictionary.
func isRelationOperatorMap(v interface{}) bool {
	m, ok := v.(map[string]interface{})
	if !ok {
		return false
	}
	for k := range m {
		if relationOperatorKeys[k] {
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

// cleanWhere flattens relation-style compound where objects (key contains '_' with a plain-map value)
// while preserving logical keys, registered relations, registered model fields, and operator maps.
func cleanWhere(where map[string]interface{}, modelName string) map[string]interface{} {
	clean := map[string]interface{}{}
	for k, v := range where {
		if k == "AND" || k == "OR" || k == "NOT" || !strings.Contains(k, "_") {
			clean[k] = v
			continue
		}
		if modelName != "" {
			if _, _, isRel := ResolveRelationForModel(modelName, k); isRel || ModelHasField(modelName, k) {
				clean[k] = v
				continue
			}
		}
		if m, ok := isPlainMap(v); ok && !isOperatorMap(m) && !isRelationOperatorMap(m) {
			for nk, nv := range m {
				clean[nk] = nv
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

func sanitizeParamName(name string) string {
	var sb strings.Builder
	for _, ch := range name {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' {
			sb.WriteRune(ch)
		} else {
			sb.WriteRune('_')
		}
	}
	cleaned := sb.String()
	if len(cleaned) > 0 && ((cleaned[0] >= 'a' && cleaned[0] <= 'z') || (cleaned[0] >= 'A' && cleaned[0] <= 'Z')) {
		return cleaned
	}
	return "p_" + cleaned
}

func parseRelationFilter(modelName, relName string, rel RelationDef, value interface{}, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string, selfRef string) (string, error) {
	rawMap, ok := isPlainMap(value)
	if !ok {
		return "", fmt.Errorf("relation filter for '%s' on '%s' must be a filter object", relName, modelName)
	}

	isMany := rel.RelationType == "many"
	normalized := make(map[string]interface{}, len(rawMap))
	for _, k := range sortedKeys(rawMap) {
		canonical := k
		if canonical == "is_not" {
			canonical = "isNot"
		}
		var allowed bool
		if isMany {
			allowed = canonical == "some" || canonical == "none" || canonical == "every"
		} else {
			allowed = canonical == "is" || canonical == "isNot"
		}
		if !allowed {
			return "", fmt.Errorf("unsupported relation filter operator '%s' for relation '%s'", k, relName)
		}
		normalized[canonical] = rawMap[k]
	}

	if len(normalized) == 0 {
		return "", nil
	}

	childTable := QuoteTable(ResolveTable(rel.ModelName), dialect)
	childKey, parentKey := ResolveRelationKeys(modelName, rel)
	childCol := QuoteIdentifier(childKey, dialect)
	parentCol := QuoteIdentifier(parentKey, dialect)

	parentRef := QuoteTable(ResolveTable(modelName), dialect) + "."
	if selfRef != "" {
		parentRef = selfRef + "."
	}

	buildExists := func(childAlias, correlation, innerWhere string) string {
		inner := ""
		if innerWhere != "" {
			inner = " AND (" + innerWhere + ")"
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM %s AS %s WHERE %s%s)", childTable, childAlias, correlation, inner)
	}

	var parts []string
	if isMany {
		for _, op := range []string{"some", "none", "every"} {
			opVal, has := normalized[op]
			if !has {
				continue
			}
			innerMap, ok := isPlainMap(opVal)
			if !ok {
				return "", fmt.Errorf("'%s' filter on relation '%s' must be an object", op, relName)
			}
			childAlias := fmt.Sprintf("r_%s", sanitizeParamName(prefix+op))
			correlation := fmt.Sprintf("%s.%s = %s%s", childAlias, childCol, parentRef, parentCol)
			inner, err := buildWhereRecWithModel(cleanWhere(innerMap, rel.ModelName), rel.ModelName, dialect, args, ph, prefix+op+"_", childAlias, childAlias+".")
			if err != nil {
				return "", err
			}
			switch op {
			case "some":
				parts = append(parts, buildExists(childAlias, correlation, inner))
			case "none":
				parts = append(parts, "NOT "+buildExists(childAlias, correlation, inner))
			case "every":
				violatedWhere := " AND 1=0"
				if inner != "" {
					violatedWhere = " AND NOT (" + inner + ")"
				}
				violated := fmt.Sprintf("EXISTS (SELECT 1 FROM %s AS %s WHERE %s%s)", childTable, childAlias, correlation, violatedWhere)
				parts = append(parts, "NOT "+violated)
			}
		}
	} else {
		for _, op := range []string{"is", "isNot"} {
			opVal, has := normalized[op]
			if !has {
				continue
			}
			childAlias := fmt.Sprintf("r_%s", sanitizeParamName(prefix+op))
			correlation := fmt.Sprintf("%s.%s = %s%s", childAlias, childCol, parentRef, parentCol)
			if opVal == nil {
				if op == "is" {
					parts = append(parts, "NOT "+buildExists(childAlias, correlation, ""))
				} else {
					parts = append(parts, buildExists(childAlias, correlation, ""))
				}
				continue
			}
			innerMap, ok := isPlainMap(opVal)
			if !ok {
				return "", fmt.Errorf("'%s' filter on relation '%s' must be an object or nil", op, relName)
			}
			inner, err := buildWhereRecWithModel(cleanWhere(innerMap, rel.ModelName), rel.ModelName, dialect, args, ph, prefix+op+"_", childAlias, childAlias+".")
			if err != nil {
				return "", err
			}
			if op == "is" {
				parts = append(parts, buildExists(childAlias, correlation, inner))
			} else {
				parts = append(parts, "NOT "+buildExists(childAlias, correlation, inner))
			}
		}
	}

	return strings.Join(parts, " AND "), nil
}

// BuildWhere converts an ORM-style where object into a SQL clause with ordered placeholders.
// ph returns the placeholder for arg position n (1-based).
func BuildWhere(where map[string]interface{}, dialect Dialect, ph func(n int) string) (string, []interface{}) {
	return BuildWhereWithModel(where, "", dialect, ph)
}

// BuildWhereWithModel converts an ORM-style where object into a SQL clause with relation filter support.
func BuildWhereWithModel(where map[string]interface{}, modelName string, dialect Dialect, ph func(n int) string) (string, []interface{}) {
	clause, args, err := TryBuildWhereWithModel(where, modelName, dialect, ph)
	if err != nil {
		return "", nil
	}
	return clause, args
}

// TryBuildWhere converts an ORM-style where object into a SQL clause with strict operator validation.
func TryBuildWhere(where map[string]interface{}, dialect Dialect, ph func(n int) string) (string, []interface{}, error) {
	return TryBuildWhereWithModel(where, "", dialect, ph)
}

// TryBuildWhereWithModel converts an ORM-style where object into a SQL clause with relation filter support
// and strict operator, field, and relation validation.
func TryBuildWhereWithModel(where map[string]interface{}, modelName string, dialect Dialect, ph func(n int) string) (string, []interface{}, error) {
	args := make([]interface{}, 0, 8)
	if where == nil || len(where) == 0 {
		return "", args, nil
	}
	clause, err := buildWhereRecWithModel(cleanWhere(where, modelName), modelName, dialect, &args, ph, "", "", "")
	if err != nil {
		return "", nil, err
	}
	return clause, args, nil
}

func buildWhereRecWithModel(where map[string]interface{}, modelName string, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string, selfRef string, colPrefix string) (string, error) {
	if where == nil || len(where) == 0 {
		return "", nil
	}
	var conditions []string

	for _, key := range sortedKeys(where) {
		value := where[key]

		switch key {
		case "OR", "AND", "NOT":
			items := value
			if m, ok := isPlainMap(value); ok {
				items = []interface{}{m}
			} else if _, isNilOrInvalid := value.(map[string]interface{}); isNilOrInvalid {
				return "", fmt.Errorf("'%s' filter payload must not be nil", key)
			}
			list, ok := toSlice(items)
			if !ok {
				return "", fmt.Errorf("'%s' filter must be an object or slice of objects", key)
			}
			var subs []string
			for i, item := range list {
				m, ok := isPlainMap(item)
				if !ok {
					return "", fmt.Errorf("'%s' filter entry must be an object", key)
				}
				s, err := buildWhereRecWithModel(cleanWhere(m, modelName), modelName, dialect, args, ph, fmt.Sprintf("%s%s%d_", prefix, key, i), selfRef, colPrefix)
				if err != nil {
					return "", err
				}
				if s == "" {
					s = "1=1"
				}
				subs = append(subs, s)
			}
			if len(subs) == 0 {
				if key == "OR" {
					conditions = append(conditions, "1=0")
				}
			} else {
				joiner := " OR "
				if key == "AND" {
					joiner = " AND "
				}
				clause := "(" + strings.Join(subs, joiner) + ")"
				if key == "NOT" {
					clause = "NOT " + clause
				}
				conditions = append(conditions, clause)
			}
			continue
		}

		if modelName != "" {
			if _, rel, exists := ResolveRelationForModel(modelName, key); exists {
				relSql, err := parseRelationFilter(modelName, key, rel, value, dialect, args, ph, fmt.Sprintf("%s%s_", prefix, key), selfRef)
				if err != nil {
					return "", err
				}
				if relSql != "" {
					conditions = append(conditions, relSql)
				}
				continue
			}
			if ModelHasFields(modelName) && !ModelHasField(modelName, key) {
				return "", fmt.Errorf("unknown field '%s' on model '%s'", key, modelName)
			}
		}

		col := colPrefix + QuoteIdentifier(key, dialect)
		fieldConds, err := buildFieldConditionWithCol(col, key, value, modelName, dialect, args, ph, prefix, selfRef, colPrefix)
		if err != nil {
			return "", err
		}
		conditions = append(conditions, fieldConds...)
	}

	return strings.Join(conditions, " AND "), nil
}

func buildFieldConditionWithCol(col string, key string, value interface{}, modelName string, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string, selfRef string, colPrefix string) ([]string, error) {
	if value == nil {
		return []string{col + " IS NULL"}, nil
	}

	m, isMap := isPlainMap(value)
	if !isMap {
		if _, isTypedNilMap := value.(map[string]interface{}); isTypedNilMap {
			return []string{col + " IS NULL"}, nil
		}
		n := len(*args) + 1
		*args = append(*args, value)
		return []string{fmt.Sprintf("%s = %s", col, ph(n))}, nil
	}

	var parts []string
	addArg := func(val interface{}) string {
		n := len(*args) + 1
		*args = append(*args, val)
		return ph(n)
	}

	insensitive := false
	if modeVal, hasMode := m["mode"]; hasMode {
		ms, ok := modeVal.(string)
		if !ok || (ms != "default" && ms != "insensitive") {
			return nil, fmt.Errorf("invalid filter mode '%v' for field '%s'", modeVal, key)
		}
		insensitive = ms == "insensitive"
	}

	opKeys := sortedKeys(m)
	for _, op := range opKeys {
		val := m[op]
		switch op {
		case "mode":
			continue
		case "not":
			if val == nil {
				parts = append(parts, col+" IS NOT NULL")
			} else if nested, ok := isPlainMap(val); ok {
				nestedConds, err := buildFieldConditionWithCol(col, key, nested, modelName, dialect, args, ph, prefix+key+"_not_", selfRef, colPrefix)
				if err != nil {
					return nil, err
				}
				if len(nestedConds) > 0 {
					parts = append(parts, "NOT ("+strings.Join(nestedConds, " AND ")+")")
				}
			} else if s, ok := val.(string); ok && insensitive {
				parts = append(parts, fmt.Sprintf("LOWER(%s) <> LOWER(%s)", col, addArg(s)))
			} else {
				parts = append(parts, fmt.Sprintf("%s <> %s", col, addArg(val)))
			}
		case "equals":
			if val == nil {
				parts = append(parts, col+" IS NULL")
			} else if s, ok := val.(string); ok && insensitive {
				parts = append(parts, fmt.Sprintf("LOWER(%s) = LOWER(%s)", col, addArg(s)))
			} else {
				parts = append(parts, fmt.Sprintf("%s = %s", col, addArg(val)))
			}
		case "contains":
			s, ok := val.(string)
			if !ok {
				return nil, fmt.Errorf("'contains' operator on field '%s' requires a string value", key)
			}
			if insensitive {
				parts = append(parts, fmt.Sprintf("LOWER(%s) LIKE LOWER(%s)", col, addArg("%"+s+"%")))
			} else {
				parts = append(parts, fmt.Sprintf("%s LIKE %s", col, addArg("%"+s+"%")))
			}
		case "startsWith":
			s, ok := val.(string)
			if !ok {
				return nil, fmt.Errorf("'startsWith' operator on field '%s' requires a string value", key)
			}
			if insensitive {
				parts = append(parts, fmt.Sprintf("LOWER(%s) LIKE LOWER(%s)", col, addArg(s+"%")))
			} else {
				parts = append(parts, fmt.Sprintf("%s LIKE %s", col, addArg(s+"%")))
			}
		case "endsWith":
			s, ok := val.(string)
			if !ok {
				return nil, fmt.Errorf("'endsWith' operator on field '%s' requires a string value", key)
			}
			if insensitive {
				parts = append(parts, fmt.Sprintf("LOWER(%s) LIKE LOWER(%s)", col, addArg("%"+s)))
			} else {
				parts = append(parts, fmt.Sprintf("%s LIKE %s", col, addArg("%"+s)))
			}
		case "gte":
			parts = append(parts, fmt.Sprintf("%s >= %s", col, addArg(val)))
		case "lte":
			parts = append(parts, fmt.Sprintf("%s <= %s", col, addArg(val)))
		case "gt":
			parts = append(parts, fmt.Sprintf("%s > %s", col, addArg(val)))
		case "lt":
			parts = append(parts, fmt.Sprintf("%s < %s", col, addArg(val)))
		case "in":
			list, ok := toSlice(val)
			if !ok {
				return nil, fmt.Errorf("'in' operator on field '%s' requires a slice or array", key)
			}
			if len(list) > 0 {
				phs := make([]string, 0, len(list))
				for _, item := range list {
					phs = append(phs, addArg(item))
				}
				parts = append(parts, fmt.Sprintf("%s IN (%s)", col, strings.Join(phs, ", ")))
			} else {
				parts = append(parts, "1=0")
			}
		case "notIn":
			list, ok := toSlice(val)
			if !ok {
				return nil, fmt.Errorf("'notIn' operator on field '%s' requires a slice or array", key)
			}
			if len(list) > 0 {
				phs := make([]string, 0, len(list))
				for _, item := range list {
					phs = append(phs, addArg(item))
				}
				parts = append(parts, fmt.Sprintf("%s NOT IN (%s)", col, strings.Join(phs, ", ")))
			} else {
				parts = append(parts, "1=1")
			}
		default:
			return nil, fmt.Errorf("unsupported filter operator '%s' for field '%s'", op, key)
		}
	}
	return parts, nil
}

// toSlice attempts to interpret value as []interface{} using typed fast paths and reflect for any slice or array.
func toSlice(value interface{}) ([]interface{}, bool) {
	if value == nil {
		return nil, false
	}
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
	}
	rv := reflect.ValueOf(value)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, false
	}
	if rv.Kind() == reflect.Slice && rv.IsNil() {
		return []interface{}{}, true
	}
	out := make([]interface{}, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		out[i] = rv.Index(i).Interface()
	}
	return out, true
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
