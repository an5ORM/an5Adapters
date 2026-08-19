// Package base provides core dialect types, quoting utilities, vector math,
// and adapter metadata for AN5 Go Adapters.
package base

import (
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

// GetFieldsForModel returns field metadata for the given model name.
func GetFieldsForModel(modelName string) interface{} {
	metaMu.RLock()
	defer metaMu.RUnlock()
	return modelFields[modelName]
}

// GetRelationsForModel returns the relation map for the given model name (read-only snapshot).
func GetRelationsForModel(modelName string) map[string]RelationDef {
	metaMu.RLock()
	defer metaMu.RUnlock()
	rels := relationMap[modelName]
	if rels == nil {
		return map[string]RelationDef{}
	}
	out := make(map[string]RelationDef, len(rels))
	for k, v := range rels {
		out[k] = v
	}
	return out
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
