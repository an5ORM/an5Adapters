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

func parseRelationFilter(modelName string, rel RelationDef, value map[string]interface{}, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string, selfRef string) string {
	modelMap := GetModelToTable()
	childRawTable := rel.ModelName
	if tbl, ok := modelMap[rel.ModelName]; ok {
		childRawTable = tbl
	}
	childTable := QuoteTable(childRawTable, dialect)
	childAlias := fmt.Sprintf("r_%s", sanitizeParamName(prefix))
	fk := QuoteIdentifier(rel.ForeignKey, dialect)
	lk := QuoteIdentifier(rel.LocalKey, dialect)

	parentTable := modelName
	if pt, ok := modelMap[modelName]; ok {
		parentTable = pt
	}
	parentRef := QuoteTable(parentTable, dialect) + "."
	if selfRef != "" {
		parentRef = selfRef + "."
	}
	correlation := fmt.Sprintf("%s.%s = %s%s", childAlias, fk, parentRef, lk)

	buildExists := func(innerWhere string) string {
		inner := ""
		if innerWhere != "" {
			inner = " AND (" + innerWhere + ")"
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM %s AS %s WHERE %s%s)", childTable, childAlias, correlation, inner)
	}

	var parts []string
	isMany := rel.RelationType == "many"

	if isMany {
		if someVal, ok := value["some"]; ok && someVal != nil {
			if sm, ok := someVal.(map[string]interface{}); ok {
				inner := buildWhereRecWithModel(cleanWhere(sm), rel.ModelName, dialect, args, ph, prefix+"some_", childAlias, childAlias+".")
				parts = append(parts, buildExists(inner))
			}
		}
		if noneVal, ok := value["none"]; ok && noneVal != nil {
			if nm, ok := noneVal.(map[string]interface{}); ok {
				inner := buildWhereRecWithModel(cleanWhere(nm), rel.ModelName, dialect, args, ph, prefix+"none_", childAlias, childAlias+".")
				parts = append(parts, "NOT "+buildExists(inner))
			}
		}
		if everyVal, ok := value["every"]; ok && everyVal != nil {
			if em, ok := everyVal.(map[string]interface{}); ok {
				inner := buildWhereRecWithModel(cleanWhere(em), rel.ModelName, dialect, args, ph, prefix+"every_", childAlias, childAlias+".")
				negated := ""
				if inner != "" {
					negated = "NOT (" + inner + ")"
				}
				violatedWhere := " AND 1=0"
				if negated != "" {
					violatedWhere = " AND " + negated
				}
				violated := fmt.Sprintf("EXISTS (SELECT 1 FROM %s AS %s WHERE %s%s)", childTable, childAlias, correlation, violatedWhere)
				parts = append(parts, "NOT "+violated)
			}
		}
	} else {
		if isVal, ok := value["is"]; ok {
			if isVal == nil {
				parts = append(parts, "NOT "+buildExists(""))
			} else if im, ok := isVal.(map[string]interface{}); ok {
				inner := buildWhereRecWithModel(cleanWhere(im), rel.ModelName, dialect, args, ph, prefix+"is_", childAlias, childAlias+".")
				parts = append(parts, buildExists(inner))
			}
		}
		if isNotVal, ok := value["isNot"]; ok {
			if isNotVal == nil {
				parts = append(parts, buildExists(""))
			} else if inm, ok := isNotVal.(map[string]interface{}); ok {
				inner := buildWhereRecWithModel(cleanWhere(inm), rel.ModelName, dialect, args, ph, prefix+"isNot_", childAlias, childAlias+".")
				parts = append(parts, "NOT "+buildExists(inner))
			}
		}
	}

	return strings.Join(parts, " AND ")
}

// BuildWhere converts an ORM-style where object into a SQL clause with ordered placeholders.
// ph returns the placeholder for arg position n (1-based).
func BuildWhere(where map[string]interface{}, dialect Dialect, ph func(n int) string) (string, []interface{}) {
	return BuildWhereWithModel(where, "", dialect, ph)
}

// BuildWhereWithModel converts an ORM-style where object into a SQL clause with relation filter support.
func BuildWhereWithModel(where map[string]interface{}, modelName string, dialect Dialect, ph func(n int) string) (string, []interface{}) {
	args := make([]interface{}, 0, 8)
	clause := buildWhereRecWithModel(cleanWhere(where), modelName, dialect, &args, ph, "", "", "")
	return clause, args
}

func buildWhereRecWithModel(where map[string]interface{}, modelName string, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string, selfRef string, colPrefix string) string {
	if where == nil || len(where) == 0 {
		return ""
	}
	var conditions []string
	var modelRels map[string]RelationDef
	if modelName != "" {
		modelRels = GetRelationsForModel(modelName)
	}

	for _, key := range sortedKeys(where) {
		value := where[key]

		switch key {
		case "OR", "AND", "NOT":
			items := value
			if m, ok := value.(map[string]interface{}); ok {
				items = []interface{}{m}
			}
			list, ok := toSlice(items)
			if !ok {
				continue
			}
			var subs []string
			for i, item := range list {
				if m, ok := item.(map[string]interface{}); ok {
					s := buildWhereRecWithModel(cleanWhere(m), modelName, dialect, args, ph, fmt.Sprintf("%s%s%d_", prefix, key, i), selfRef, colPrefix)
					if s == "" {
						s = "1=1"
					}
					subs = append(subs, s)
				}
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

		if modelRels != nil {
			if rel, exists := modelRels[key]; exists {
				if vm, ok := isPlainMap(value); ok {
					relSql := parseRelationFilter(modelName, rel, vm, dialect, args, ph, fmt.Sprintf("%s%s_", prefix, key), selfRef)
					if relSql != "" {
						conditions = append(conditions, relSql)
						continue
					}
				}
			}
		}

		col := colPrefix + QuoteIdentifier(key, dialect)
		conditions = append(conditions, buildFieldConditionWithCol(col, key, value, dialect, args, ph, prefix)...)
	}

	return strings.Join(conditions, " AND ")
}

func buildFieldConditionWithCol(col string, key string, value interface{}, dialect Dialect, args *[]interface{}, ph func(n int) string, prefix string) []string {

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
			} else if nested, ok := val.(map[string]interface{}); ok {
				nestedCond := buildWhereRecWithModel(map[string]interface{}{key: nested}, "", dialect, args, ph, key+"_not_", "", "")
				if nestedCond != "" {
					parts = append(parts, "NOT ("+nestedCond+")")
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
