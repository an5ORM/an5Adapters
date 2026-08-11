// Package base provides core dialect types, quoting utilities, vector math,
// and adapter metadata for AN5 Go Adapters.
package base

import (
	"strings"
	"sync"
)

// AdapterMetadata holds model-to-table and field mapping injected by generated clients.
type AdapterMetadata struct {
	ModelToTable map[string]string
	ModelFields  map[string]interface{}
}

var (
	metaMu       sync.RWMutex
	modelToTable = map[string]string{}
	modelFields  = map[string]interface{}{}
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
