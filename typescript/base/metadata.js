"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setAdapterMetadata = setAdapterMetadata;
exports.getModelToTable = getModelToTable;
exports.getFieldsForModel = getFieldsForModel;
let modelToTable = {};
let modelFields = {};
function setAdapterMetadata(metadata) {
    modelToTable = { ...(metadata.modelToTable || {}) };
    modelFields = { ...(metadata.modelFields || {}) };
}
function getModelToTable() {
    return modelToTable;
}
function getFieldsForModel(modelName) {
    return modelFields[modelName] || {};
}
