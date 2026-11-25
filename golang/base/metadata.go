// Package base provides core dialect types, quoting utilities, vector math,
// and adapter metadata for AN5 Go Adapters.
package base

import (
	"sort"
	"strings"
	"sync"
)

// RelationDef describes a model relation for eager-loading (include) support.
type RelationDef struct {
	ModelName    string
	RelationType string // "many" | "one"
	ForeignKey   string
	LocalKey     string
}

// AdapterMetadata holds model-to-table, field mapping, and relation mapping injected by generated clients.
type AdapterMetadata struct {
	ModelToTable map[string]string
	ModelFields  map[string]interface{}
	RelationMap  map[string]map[string]RelationDef
}

var (
	metaMu       sync.RWMutex
	modelToTable = map[string]string{}
	modelFields  = map[string]interface{}{}
	relationMap  = map[string]map[string]RelationDef{}
)

// SetAdapterMetadata stores metadata provided by the generated an5Client.
// Call this once at application startup after initializing the DB context.
func SetAdapterMetadata(meta AdapterMetadata) {
	metaMu.Lock()
	defer metaMu.Unlock()
	modelToTable = make(map[string]string, len(meta.ModelToTable))
	for k, v := range meta.ModelToTable {
		modelToTable[k] = v
	}
	modelFields = make(map[string]interface{}, len(meta.ModelFields))
	for k, v := range meta.ModelFields {
		modelFields[k] = v
	}
	relationMap = make(map[string]map[string]RelationDef, len(meta.RelationMap))
	for model, rels := range meta.RelationMap {
		relationMap[model] = make(map[string]RelationDef, len(rels))
		for key, def := range rels {
			relationMap[model][key] = def
		}
	}
}

// GetModelToTable returns the model-to-table mapping (read-only snapshot).
func GetModelToTable() map[string]string {
	metaMu.RLock()
	defer metaMu.RUnlock()
	out := make(map[string]string, len(modelToTable))
	for k, v := range modelToTable {
		out[k] = v
	}
	return out
}

// GetFieldsForModel returns field metadata for the given model name (case-insensitive fallback).
func GetFieldsForModel(modelName string) interface{} {
	metaMu.RLock()
	defer metaMu.RUnlock()
	return getFieldsLocked(modelName)
}

func getFieldsLocked(modelName string) interface{} {
	if modelName == "" {
		return nil
	}
	if fields, ok := modelFields[modelName]; ok {
		return fields
	}
	for k, v := range modelFields {
		if strings.EqualFold(k, modelName) {
			return v
		}
	}
	return nil
}

// ModelHasFields returns true if field metadata is registered for modelName.
func ModelHasFields(modelName string) bool {
	fields := GetFieldsForModel(modelName)
	switch v := fields.(type) {
	case map[string]interface{}:
		return len(v) > 0
	case map[string]bool:
		return len(v) > 0
	case map[string]string:
		return len(v) > 0
	case []map[string]interface{}:
		return len(v) > 0
	case []interface{}:
		return len(v) > 0
	case []string:
		return len(v) > 0
	default:
		return false
	}
}

// ModelHasField checks whether col (exact, case-insensitive, or snake_case) is a registered field of modelName.
func ModelHasField(modelName, col string) bool {
	if modelName == "" || col == "" {
		return false
	}
	fields := GetFieldsForModel(modelName)
	if fields == nil {
		return false
	}
	targetSnake := ToSnakeCase(col)
	matchesName := func(candidate string) bool {
		return candidate == col || strings.EqualFold(candidate, col) || ToSnakeCase(candidate) == targetSnake
	}
	switch v := fields.(type) {
	case map[string]interface{}:
		for k := range v {
			if matchesName(k) {
				return true
			}
		}
	case map[string]bool:
		for k, enabled := range v {
			if enabled && matchesName(k) {
				return true
			}
		}
	case map[string]string:
		for k := range v {
			if matchesName(k) {
				return true
			}
		}
	case []map[string]interface{}:
		for _, item := range v {
			if n, ok := item["name"].(string); ok && matchesName(n) {
				return true
			}
		}
	case []interface{}:
		for _, raw := range v {
			switch item := raw.(type) {
			case string:
				if matchesName(item) {
					return true
				}
			case map[string]interface{}:
				if n, ok := item["name"].(string); ok && matchesName(n) {
					return true
				}
			}
		}
	case []string:
		for _, n := range v {
			if matchesName(n) {
				return true
			}
		}
	}
	return false
}

// GetRelationsForModel returns the relation map for the given model name (read-only snapshot, case-insensitive fallback).
func GetRelationsForModel(modelName string) map[string]RelationDef {
	metaMu.RLock()
	defer metaMu.RUnlock()
	if modelName == "" {
		return map[string]RelationDef{}
	}
	rels := relationMap[modelName]
	if rels == nil {
		for k, v := range relationMap {
			if strings.EqualFold(k, modelName) {
				rels = v
				break
			}
		}
	}
	if rels == nil {
		return map[string]RelationDef{}
	}
	out := make(map[string]RelationDef, len(rels))
	for k, v := range rels {
		out[k] = v
	}
	return out
}

// ResolveRelationForModel looks up a relation by exact key, case-insensitive match, or snake_case alias.
func ResolveRelationForModel(modelName, key string) (string, RelationDef, bool) {
	rels := GetRelationsForModel(modelName)
	if len(rels) == 0 {
		return "", RelationDef{}, false
	}
	if def, ok := rels[key]; ok {
		return key, def, true
	}
	names := make([]string, 0, len(rels))
	for relName := range rels {
		names = append(names, relName)
	}
	sort.Strings(names)
	for _, relName := range names {
		if strings.EqualFold(relName, key) {
			return relName, rels[relName], true
		}
	}
	targetSnake := ToSnakeCase(key)
	for _, relName := range names {
		if ToSnakeCase(relName) == targetSnake {
			return relName, rels[relName], true
		}
	}
	return "", RelationDef{}, false
}

// ResolveRelationKeys resolves (childCol, parentCol) for a relation filter or eager-load.
func ResolveRelationKeys(parentModel string, rel RelationDef) (string, string) {
	rawFK := rel.ForeignKey
	if rawFK == "" {
		rawFK = "id"
	}
	rawLK := rel.LocalKey
	if rawLK == "" {
		rawLK = "id"
	}
	if rel.RelationType == "many" {
		return rawFK, rawLK
	}
	// Generated relation maps record ForeignKey on the referencing side and LocalKey on the referenced target.
	// Disambiguate inverse 1-to-1 relations (parent holds LocalKey, child holds ForeignKey) from FK-holding
	// to-one relations using field metadata when available.
	if (ModelHasField(rel.ModelName, rawFK) && !ModelHasField(rel.ModelName, rawLK)) ||
		(ModelHasField(parentModel, rawLK) && !ModelHasField(parentModel, rawFK)) {
		return rawFK, rawLK
	}
	return rawLK, rawFK
}

// GetRelationMap returns the full model-to-relations map (read-only snapshot).
func GetRelationMap() map[string]map[string]RelationDef {
	metaMu.RLock()
	defer metaMu.RUnlock()
	out := make(map[string]map[string]RelationDef, len(relationMap))
	for model, rels := range relationMap {
		out[model] = make(map[string]RelationDef, len(rels))
		for k, v := range rels {
			out[model][k] = v
		}
	}
	return out
}

// ResolveTable looks up the physical table name for a model name (case-insensitive fallback).
func ResolveTable(modelName string) string {
	metaMu.RLock()
	defer metaMu.RUnlock()
	if t, ok := modelToTable[modelName]; ok {
		return t
	}
	// lowercase fallback
	lower := strings.ToLower(modelName)
	for k, v := range modelToTable {
		if strings.ToLower(k) == lower {
			return v
		}
	}
	return modelName
}
