import Foundation

/// One column of a model, as emitted by the generator into the metadata.
public struct FieldMeta: Equatable, Sendable {
    public let name: String
    public let type: String
    public let sqlType: String?
    public let isOptional: Bool
    public let hasDefault: Bool
    public let isId: Bool
    public let description: String?

    public init(
        name: String,
        type: String,
        sqlType: String? = nil,
        isOptional: Bool = false,
        hasDefault: Bool = false,
        isId: Bool = false,
        description: String? = nil
    ) {
        self.name = name
        self.type = type
        self.sqlType = sqlType
        self.isOptional = isOptional
        self.hasDefault = hasDefault
        self.isId = isId
        self.description = description
    }
}

extension FieldMeta {

/// Decodes one field entry out of the metadata the generated client passes in.
public init?(field: [String: Any?]) {
    guard let name = field["name"] as? String else { return nil }
    self.init(
        name: name,
        type: field["type"] as? String ?? "string",
        sqlType: (field["sql"] as? String) ?? (field["sqlType"] as? String),
        isOptional: (field["isOptional"] as? Bool) ?? (field["optional"] as? Bool) ?? false,
        hasDefault: (field["hasDefault"] as? Bool) ?? (field["default"] as? Bool) ?? false,
        isId: (field["isId"] as? Bool) ?? (field["id"] as? Bool) ?? false,
        description: field["description"] as? String
    )
}

}

/// One relation of a model.
///
/// `relationType` is `"one"` or `"many"`. The two sides of the join are named the way the
/// foreign key is stored: `foreignKey` is the column on the related model that points back,
/// `localKey` the column on this model it points to.
public struct RelationDef: Equatable, Sendable {
    public let modelName: String
    public let relationType: String
    public let foreignKey: String
    public let localKey: String

    public var isMany: Bool { relationType == "many" }

    public init(modelName: String, relationType: String, foreignKey: String, localKey: String) {
        self.modelName = modelName
        self.relationType = relationType.isEmpty ? "many" : relationType
        self.foreignKey = foreignKey
        self.localKey = localKey
    }
}

extension RelationDef {

public init?(relation: [String: Any?]) {
    guard let modelName = (relation["modelName"] as? String)
            ?? (relation["model_name"] as? String)
            ?? (relation["model"] as? String) else { return nil }
    self.init(
        modelName: modelName,
        relationType: (relation["relationType"] as? String)
            ?? (relation["relation_type"] as? String)
            ?? (relation["type"] as? String)
            ?? "many",
        foreignKey: (relation["foreignKey"] as? String) ?? (relation["foreign_key"] as? String) ?? "",
        localKey: (relation["localKey"] as? String) ?? (relation["local_key"] as? String) ?? ""
    )
}

}

/// The generated models' table names, columns and relations.
///
/// A value type rather than a process-wide singleton: a Swift app may hold more than one
/// database — a local on-device SQLite and a synced server one — and a global registry would
/// make the second one's table names overwrite the first's.
public struct Metadata: Sendable {

    public let modelToTable: [String: String]
    public let modelFields: [String: [FieldMeta]]
    public let relationMap: [String: [String: RelationDef]]

    public static let empty = Metadata(modelToTable: [:], modelFields: [:], relationMap: [:])

    public init(
        modelToTable: [String: String],
        modelFields: [String: [FieldMeta]],
        relationMap: [String: [String: RelationDef]]
    ) {
        self.modelToTable = modelToTable
        self.modelFields = modelFields
        self.relationMap = relationMap
    }

    /// The metadata the generated client passes in, accepting either spelling of each key.
    public init?(_ raw: [String: Any?]) {
        let tables = (raw["model_to_table"] as? [String: Any?]) ?? (raw["modelToTable"] as? [String: Any?])
        guard let tables else { return nil }

        var parsedTables: [String: String] = [:]
        for (model, table) in tables {
            if let text = table as? String { parsedTables[model] = text }
        }

        var parsedFields: [String: [FieldMeta]] = [:]
        if let fields = (raw["model_fields"] as? [String: Any?]) ?? (raw["modelFields"] as? [String: Any?]) {
            for (model, entries) in fields {
                guard let list = entries as? [Any] else { continue }
                parsedFields[model] = list.compactMap { entry in
                    (entry as? [String: Any?]).flatMap { FieldMeta(field: $0) }
                }
            }
        }

        var parsedRelations: [String: [String: RelationDef]] = [:]
        if let relations = (raw["relation_map"] as? [String: Any?])
            ?? (raw["relationMap"] as? [String: Any?])
            ?? (raw["RELATION_MAP"] as? [String: Any?]) {
            for (model, entries) in relations {
                guard let list = entries as? [String: Any?] else { continue }
                var forModel: [String: RelationDef] = [:]
                for (name, entry) in list {
                    if let definition = (entry as? [String: Any?]).flatMap({ RelationDef(relation: $0) }) {
                        forModel[name] = definition
                    }
                }
                parsedRelations[model] = forModel
            }
        }

        self.init(modelToTable: parsedTables, modelFields: parsedFields, relationMap: parsedRelations)
    }

    /// The model's name as the metadata keys it, accepting a different capitalisation.
    ///
    /// The generated client registers tables under their PascalCase name while the metadata
    /// keys them in camelCase. A plain lookup would find no columns at all and silently skip
    /// `isId` — never generating the primary key.
    public func modelKey(_ modelName: String) -> String {
        if modelToTable[modelName] != nil || modelFields[modelName] != nil { return modelName }
        let camel = modelName.prefix(1).lowercased() + modelName.dropFirst()
        if modelToTable[camel] != nil || modelFields[camel] != nil { return camel }
        let lower = modelName.lowercased()
        if modelToTable[lower] != nil || modelFields[lower] != nil { return lower }
        return modelName
    }

    /// The table a model maps to, or the model name when the schema declared none.
    public func table(_ modelName: String) -> String {
        modelToTable[modelKey(modelName)] ?? modelName
    }

    public func fields(_ modelName: String) -> [FieldMeta] {
        modelFields[modelKey(modelName)] ?? modelFields[modelName] ?? []
    }

    /// The primary key column, or `nil` when the schema marked none.
    public func idField(_ modelName: String) -> FieldMeta? {
        fields(modelName).first { $0.isId }
    }

    public func relations(_ modelName: String) -> [String: RelationDef] {
        relationMap[modelName] ?? relationMap[modelKey(modelName)] ?? [:]
    }
}