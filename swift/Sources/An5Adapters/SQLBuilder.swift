import Foundation

/// The database dialects AN5 speaks, and everything that differs between them.
///
/// The differences are not cosmetic: quoting, pagination and the `WITH (NOLOCK)` hint each
/// have to be produced per dialect, and getting one wrong yields SQL the target engine
/// cannot parse.
public enum Dialect: String, CaseIterable, Sendable {
    case mssql
    case postgres
    case sqlite

    /// The dialect a connection string points at.
    ///
    /// Lower-cased first: a URI scheme is case-insensitive, so `MySQL://` and `mysql://` are
    /// the same connection.
    public static func detect(_ connectionString: String) -> Dialect {
        let value = connectionString.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("postgres://") || value.hasPrefix("postgresql://") {
            return .postgres
        }
        if value.hasPrefix("sqlite://")
            || value.hasPrefix("sqlite:")
            || value.hasPrefix("file:")
            || value.hasSuffix(".db")
            || value.hasSuffix(".sqlite")
            || value.hasSuffix(".sqlite3")
            || value == ":memory:" {
            return .sqlite
        }
        return .mssql
    }

    /// The bind placeholder.
    ///
    /// Every driver AN5 speaks binds positionally, so this is `?` throughout; it exists so
    /// the SQL builder never hardcodes a placeholder and a new driver has one place to differ.
    public var placeholder: String { "?" }

    /// Quotes a bare column or identifier name for this dialect.
    public func quote(_ name: String) -> String {
        let unwrapped = Dialect.strip(name, left: "[", right: "]")
        switch self {
        case .mssql:
            return "[" + unwrapped.replacingOccurrences(of: "]", with: "]]") + "]"
        case .postgres, .sqlite:
            let bare = Dialect.strip(unwrapped, left: "\"", right: "\"")
            return "\"" + bare.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
    }

    /// `WITH (NOLOCK)` is an MSSQL table hint; no other dialect has an equivalent.
    public var supportsNoLock: Bool { self == .mssql }

    /// The trailing limit clause.
    ///
    /// SQLite has `LIMIT ... OFFSET` like PostgreSQL. Emitting the MSSQL
    /// `OFFSET ... FETCH NEXT` form against SQLite produces SQL it cannot parse.
    public func pagination(take: Int?, skip: Int, orderBy: String) -> String {
        guard let take else { return "" }
        if self == .mssql {
            let prefix = orderBy.isEmpty ? " ORDER BY (SELECT NULL)" : ""
            return "\(prefix) OFFSET \(max(0, skip)) ROWS FETCH NEXT \(take) ROWS ONLY"
        }
        return " LIMIT \(take) OFFSET \(max(0, skip))"
    }

    static func strip(_ value: String, left: String, right: String) -> String {
        guard value.count >= left.count + right.count,
              value.hasPrefix(left),
              value.hasSuffix(right) else { return value }
        return String(value.dropFirst(left.count).dropLast(right.count))
    }
}

/// The `WHERE` clause for a filter tree, with the values it binds in order.
public struct WhereClause {
    public let sql: String
    public let parameters: [SQLValue]

    public var isEmpty: Bool { sql.isEmpty }

    public init(sql: String = "", parameters: [SQLValue] = []) {
        self.sql = sql
        self.parameters = parameters
    }
}

/// Turns a filter tree into SQL and the bind values that go with it.
public enum SQLBuilder {

    /// The operator keys that make a map a filter rather than a nested condition.
    static let operatorKeys: Set<String> = [
        "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt", "mode",
    ]

    /// Relation filter operator keys supported on to-many and to-one relations.
    static let relationManyKeys: Set<String> = ["some", "none", "every"]
    static let relationOneKeys: Set<String> = ["is", "isNot", "is_not"]

    /// Builds the `WHERE` clause and the parameters it binds, in order.
    ///
    /// Kept as a non-throwing wrapper over ``buildWhere(_:dialect:model:metadata:prefix:)``
    /// for callers that do not validate or use model relation metadata.
    public static func whereClause(_ filter: Where?, dialect: Dialect, prefix: String = "") -> WhereClause {
        (try? buildWhere(filter, dialect: dialect, model: nil, metadata: .empty, prefix: prefix)) ?? WhereClause()
    }

    /// Builds a model-aware `WHERE` clause and validates all scalar and relation filter operators.
    ///
    /// Every value reaches the database as a bind parameter; none is ever formatted into the
    /// SQL. `AND`/`OR`/`NOT` groups, relation filters (`some`/`none`/`every`/`is`/`isNot`),
    /// and compound unique key flattening are supported, and an empty `in: []` becomes `1=0`
    /// rather than the invalid `IN ()`.
    public static func buildWhere(
        _ filter: Where?,
        dialect: Dialect,
        model: String? = nil,
        metadata: Metadata = .empty,
        prefix: String = ""
    ) throws -> WhereClause {
        guard let filter, !filter.isEmpty else { return WhereClause() }
        var parameters: [SQLValue] = []
        let cleaned = cleanWhere(filter, model: model, metadata: metadata)
        let sql = try buildWhereRec(
            cleaned,
            dialect: dialect,
            model: model,
            metadata: metadata,
            prefix: prefix,
            selfRef: "",
            colPrefix: "",
            parameters: &parameters
        )
        return WhereClause(sql: sql, parameters: parameters)
    }

    /// Hoists compound-key objects (`id_score: {id: ..., score: ...}`) without flattening
    /// scalar operator maps or relation filter maps.
    private static func cleanWhere(_ filter: Where, model: String?, metadata: Metadata) -> Where {
        let hasFields = model.map { metadata.hasFields($0) } ?? false
        var flattened: Where = [:]
        for (key, value) in filter {
            let isCompoundCandidate: Bool = {
                guard key.contains("_") else { return false }
                guard let model else { return true }
                return !metadata.hasField(model, key) && metadata.relation(model, key) == nil
            }()
            if isCompoundCandidate,
               let nested = asFilterMap(value),
               !nested.isEmpty,
               !isOperatorValue(nested),
               !isRelationOperatorValue(nested),
               (!hasFields || nested.keys.allSatisfy { metadata.hasField(model!, $0) }) {
                for (nestedKey, nestedValue) in nested {
                    flattened[nestedKey] = nestedValue
                }
            } else {
                flattened[key] = value
            }
        }
        return flattened
    }

    private static func buildWhereRec(
        _ filter: Where,
        dialect: Dialect,
        model: String?,
        metadata: Metadata,
        prefix: String,
        selfRef: String,
        colPrefix: String,
        parameters: inout [SQLValue]
    ) throws -> String {
        guard !filter.isEmpty else { return "" }

        var conditions: [String] = []
        for key in filter.keys.sorted() {
            let value = filter[key] ?? nil
            switch key {
            case "OR":
                guard let branches = asFilterList(value) else {
                    throw An5Error.invalidQuery("'OR' filter must be an array of filter dictionaries")
                }
                var sub: [String] = []
                for (index, branch) in branches.enumerated() {
                    let sql = try buildWhereRec(
                        cleanWhere(branch, model: model, metadata: metadata),
                        dialect: dialect,
                        model: model,
                        metadata: metadata,
                        prefix: "\(prefix)or\(index)_",
                        selfRef: selfRef,
                        colPrefix: colPrefix,
                        parameters: &parameters
                    )
                    sub.append(sql.isEmpty ? "1=1" : sql)
                }
                conditions.append(sub.isEmpty ? "1=0" : "(\(sub.joined(separator: " OR ")))")
            case "AND":
                let items: [Where]
                if let list = asFilterList(value) {
                    items = list
                } else if let single = asFilterMap(value) {
                    items = [single]
                } else {
                    throw An5Error.invalidQuery("'AND' filter must be a filter dictionary or array of filter dictionaries")
                }
                var sub: [String] = []
                for (index, item) in items.enumerated() {
                    let sql = try buildWhereRec(
                        cleanWhere(item, model: model, metadata: metadata),
                        dialect: dialect,
                        model: model,
                        metadata: metadata,
                        prefix: "\(prefix)and\(index)_",
                        selfRef: selfRef,
                        colPrefix: colPrefix,
                        parameters: &parameters
                    )
                    if !sql.isEmpty { sub.append(sql) }
                }
                if !sub.isEmpty { conditions.append("(\(sub.joined(separator: " AND ")))") }
            case "NOT":
                let items: [Where]
                if let list = asFilterList(value) {
                    items = list
                } else if let single = asFilterMap(value) {
                    items = [single]
                } else {
                    throw An5Error.invalidQuery("'NOT' filter must be a filter dictionary or array of filter dictionaries")
                }
                var sub: [String] = []
                for (index, item) in items.enumerated() {
                    let sql = try buildWhereRec(
                        cleanWhere(item, model: model, metadata: metadata),
                        dialect: dialect,
                        model: model,
                        metadata: metadata,
                        prefix: "\(prefix)not\(index)_",
                        selfRef: selfRef,
                        colPrefix: colPrefix,
                        parameters: &parameters
                    )
                    sub.append(sql.isEmpty ? "1=1" : sql)
                }
                if !sub.isEmpty { conditions.append("NOT (\(sub.joined(separator: " OR ")))") }
            default:
                if let model, let relation = metadata.relation(model, key) {
                    let relSql = try relationCondition(
                        model: model,
                        relationName: key,
                        relation: relation,
                        value: value,
                        dialect: dialect,
                        metadata: metadata,
                        prefix: "\(prefix)\(key)_",
                        selfRef: selfRef,
                        parameters: &parameters
                    )
                    if !relSql.isEmpty { conditions.append(relSql) }
                } else {
                    let sql = try scalarCondition(
                        key: key,
                        value: value,
                        dialect: dialect,
                        model: model,
                        metadata: metadata,
                        prefix: prefix,
                        selfRef: selfRef,
                        colPrefix: colPrefix,
                        parameters: &parameters
                    )
                    if !sql.isEmpty { conditions.append(sql) }
                }
            }
        }
        return conditions.filter { !$0.isEmpty }.joined(separator: " AND ")
    }

    private static func relationCondition(
        model: String,
        relationName: String,
        relation: RelationDef,
        value: Any?,
        dialect: Dialect,
        metadata: Metadata,
        prefix: String,
        selfRef: String,
        parameters: inout [SQLValue]
    ) throws -> String {
        guard let map = asFilterMap(value) else {
            throw An5Error.invalidQuery("relation filter for '\(relationName)' on '\(model)' must be a filter dictionary")
        }

        let isMany = relation.isMany
        var normalized: Where = [:]
        for op in map.keys.sorted() {
            let canonical = op == "is_not" ? "isNot" : op
            let allowed = isMany
                ? relationManyKeys.contains(canonical)
                : (canonical == "is" || canonical == "isNot")
            guard allowed else {
                throw An5Error.invalidQuery("unsupported relation filter operator '\(op)' for relation '\(relationName)'")
            }
            normalized[canonical] = map[op] ?? nil
        }

        let childTable = quoteTable(metadata.table(relation.modelName), dialect: dialect)
        let (childKey, parentKey) = metadata.relationKeys(model, relation)
        let childCol = dialect.quote(childKey)
        let parentCol = dialect.quote(parentKey)
        let parentRef = selfRef.isEmpty ? "\(quoteTable(metadata.table(model), dialect: dialect))." : "\(selfRef)."

        func makeAlias(_ op: String) -> String {
            "r_\(sanitizeParameterName("\(prefix)\(op)_"))"
        }

        func buildExists(alias: String, innerWhere: String) -> String {
            let correlation = "\(alias).\(childCol) = \(parentRef)\(parentCol)"
            let inner = innerWhere.isEmpty ? "" : " AND (\(innerWhere))"
            return "EXISTS (SELECT 1 FROM \(childTable) AS \(alias) WHERE \(correlation)\(inner))"
        }

        func buildChildWhere(_ rawInner: Any?, op: String, alias: String, allowNull: Bool) throws -> String? {
            if isNullValue(rawInner) {
                if allowNull { return nil }
                throw An5Error.invalidQuery("'\(op)' filter on relation '\(relationName)' must be a filter dictionary")
            }
            guard let innerMap = asFilterMap(rawInner) else {
                let suffix = allowNull ? " or nil" : ""
                throw An5Error.invalidQuery("'\(op)' filter on relation '\(relationName)' must be a filter dictionary\(suffix)")
            }
            return try buildWhereRec(
                cleanWhere(innerMap, model: relation.modelName, metadata: metadata),
                dialect: dialect,
                model: relation.modelName,
                metadata: metadata,
                prefix: "\(prefix)\(op)_",
                selfRef: alias,
                colPrefix: "\(alias).",
                parameters: &parameters
            )
        }

        var parts: [String] = []
        if isMany {
            for op in ["some", "none", "every"] where normalized.keys.contains(op) {
                let rawInner = normalized[op] ?? nil
                if isNullValue(rawInner) { continue }
                let alias = makeAlias(op)
                guard let inner = try buildChildWhere(rawInner, op: op, alias: alias, allowNull: false) else {
                    continue
                }
                if op == "some" {
                    parts.append(buildExists(alias: alias, innerWhere: inner))
                } else if op == "none" {
                    parts.append("NOT " + buildExists(alias: alias, innerWhere: inner))
                } else {
                    let correlation = "\(alias).\(childCol) = \(parentRef)\(parentCol)"
                    let violatedWhere = inner.isEmpty ? " AND 1=0" : " AND NOT (\(inner))"
                    let violated = "EXISTS (SELECT 1 FROM \(childTable) AS \(alias) WHERE \(correlation)\(violatedWhere))"
                    parts.append("NOT \(violated)")
                }
            }
        } else {
            if normalized.keys.contains("is") {
                let rawInner = normalized["is"] ?? nil
                let alias = makeAlias("is")
                if let inner = try buildChildWhere(rawInner, op: "is", alias: alias, allowNull: true) {
                    parts.append(buildExists(alias: alias, innerWhere: inner))
                } else {
                    parts.append("NOT " + buildExists(alias: alias, innerWhere: ""))
                }
            }
            if normalized.keys.contains("isNot") {
                let rawInner = normalized["isNot"] ?? nil
                let alias = makeAlias("isNot")
                if let inner = try buildChildWhere(rawInner, op: "isNot", alias: alias, allowNull: true) {
                    parts.append("NOT " + buildExists(alias: alias, innerWhere: inner))
                } else {
                    parts.append(buildExists(alias: alias, innerWhere: ""))
                }
            }
        }

        return parts.joined(separator: " AND ")
    }

    private static func scalarCondition(
        key: String,
        value: Any?,
        dialect: Dialect,
        model: String?,
        metadata: Metadata,
        prefix: String,
        selfRef: String,
        colPrefix: String,
        parameters: inout [SQLValue]
    ) throws -> String {
        let column = "\(colPrefix)\(dialect.quote(key))"
        let placeholder = dialect.placeholder

        if isNullValue(value) {
            return "\(column) IS NULL"
        }
        guard let operators = asFilterMap(value) else {
            parameters.append(SQLValue.encode(value) ?? .null)
            return "\(column) = \(placeholder)"
        }

        var conditions: [String] = []
        for op in operators.keys.sorted() {
            let operand = operators[op] ?? nil
            switch op {
            case "not":
                if isNullValue(operand) {
                    conditions.append("\(column) IS NOT NULL")
                } else if let nested = asFilterMap(operand) {
                    let innerSql = try buildWhereRec(
                        [key: nested],
                        dialect: dialect,
                        model: model,
                        metadata: metadata,
                        prefix: "\(prefix)\(key)_not_",
                        selfRef: selfRef,
                        colPrefix: colPrefix,
                        parameters: &parameters
                    )
                    if !innerSql.isEmpty { conditions.append("NOT (\(innerSql))") }
                } else {
                    parameters.append(SQLValue.encode(operand) ?? .null)
                    conditions.append("\(column) <> \(placeholder)")
                }
            case "equals":
                if isNullValue(operand) {
                    conditions.append("\(column) IS NULL")
                } else {
                    parameters.append(SQLValue.encode(operand) ?? .null)
                    conditions.append("\(column) = \(placeholder)")
                }
            case "contains":
                parameters.append(.text("%\(literal(operand))%"))
                conditions.append("\(column) LIKE \(placeholder)")
            case "startsWith":
                parameters.append(.text("\(literal(operand))%"))
                conditions.append("\(column) LIKE \(placeholder)")
            case "endsWith":
                parameters.append(.text("%\(literal(operand))"))
                conditions.append("\(column) LIKE \(placeholder)")
            case "gte":
                parameters.append(SQLValue.encode(operand) ?? .null)
                conditions.append("\(column) >= \(placeholder)")
            case "lte":
                parameters.append(SQLValue.encode(operand) ?? .null)
                conditions.append("\(column) <= \(placeholder)")
            case "gt":
                parameters.append(SQLValue.encode(operand) ?? .null)
                conditions.append("\(column) > \(placeholder)")
            case "lt":
                parameters.append(SQLValue.encode(operand) ?? .null)
                conditions.append("\(column) < \(placeholder)")
            case "in", "notIn":
                guard let values = asValueList(operand) else {
                    throw An5Error.invalidQuery("'\(op)' operator for field '\(key)' requires an array")
                }
                if values.isEmpty {
                    // `IN ()` is a syntax error in every dialect. An empty set can match nothing,
                    // so it becomes 1=0; the negated form is true of every row, so 1=1.
                    conditions.append(op == "in" ? "1=0" : "1=1")
                } else {
                    let sqlOp = op == "in" ? " IN (" : " NOT IN ("
                    conditions.append(column + sqlOp + values.map { _ in placeholder }.joined(separator: ", ") + ")")
                    parameters.append(contentsOf: values.map { SQLValue.encode($0) ?? .null })
                }
            case "mode":
                // Collation/case-sensitivity mode is accepted for parity across generated clients.
                continue
            default:
                throw An5Error.invalidQuery("unsupported filter operator '\(op)' for field '\(key)'")
            }
        }
        return conditions.joined(separator: " AND ")
    }

    private static func isNullValue(_ value: Any?) -> Bool {
        guard let value else { return true }
        if value is NSNull { return true }
        let mirror = Mirror(reflecting: value)
        return mirror.displayStyle == .optional && mirror.children.isEmpty
    }

    private static func asFilterMap(_ value: Any?) -> Where? {
        guard !isNullValue(value), let value else { return nil }
        if let dict = value as? Where { return dict }
        if let dict = value as? [String: Any] {
            return dict.mapValues { $0 as Any? }
        }
        if let ns = value as? NSDictionary {
            var out: Where = [:]
            for (k, v) in ns {
                guard let key = k as? String else { return nil }
                out[key] = v
            }
            return out
        }
        return nil
    }

    private static func asFilterList(_ value: Any?) -> [Where]? {
        guard !isNullValue(value), let value else { return nil }
        if let list = value as? [Where] { return list }
        if let list = value as? [[String: Any]] {
            return list.map { $0.mapValues { $0 as Any? } }
        }
        if let rawList = value as? [Any] {
            var out: [Where] = []
            out.reserveCapacity(rawList.count)
            for item in rawList {
                guard let mapped = asFilterMap(item) else { return nil }
                out.append(mapped)
            }
            return out
        }
        if let ns = value as? NSArray {
            var out: [Where] = []
            out.reserveCapacity(ns.count)
            for item in ns {
                guard let mapped = asFilterMap(item) else { return nil }
                out.append(mapped)
            }
            return out
        }
        return nil
    }

    private static func asValueList(_ value: Any?) -> [Any?]? {
        guard !isNullValue(value), let value else { return nil }
        if let typed = value as? [Any?] { return typed }
        if let list = value as? [Any] { return list.map { $0 as Any? } }
        if let ns = value as? NSArray { return ns.map { $0 as Any? } }
        return nil
    }

    /// A bind value as the text a `LIKE` operand needs.
    private static func literal(_ value: Any?) -> String {
        switch SQLValue.encode(value) {
        case .some(.text(let text)): return text
        case .some(.integer(let number)): return String(number)
        case .some(.real(let number)): return String(number)
        case .some(.uuid(let uuid)): return uuid.uuidString
        default: return ""
        }
    }

    /// Builds the `ORDER BY` clause.
    ///
    /// Accepts every shape the other clients use for ordering — a single column, a
    /// column/direction pair, a dictionary, or a list of dictionaries — because a generated
    /// client may hand over whichever form its own language finds natural.
    public static func orderBy(_ orderBy: Any?, dialect: Dialect) -> String {
        var parts: [String] = []
        for entry in orderEntries(orderBy) {
            for (column, direction) in entry {
                parts.append("\(dialect.quote(column)) \(direction.lowercased() == "desc" ? "DESC" : "ASC")")
            }
        }
        return parts.isEmpty ? "" : "ORDER BY \(parts.joined(separator: ", "))"
    }

    /// Normalises any accepted ordering shape into column/direction entries.
    static func orderEntries(_ orderBy: Any?) -> [[String: String]] {
        if let list = orderBy as? [[String: String]] { return list }
        if let list = orderBy as? [[String: Any?]] {
            return list.map { $0.mapValues { ($0 as? String) ?? "asc" } }
        }
        if let single = orderBy as? [String: String] { return [single] }
        if let single = orderBy as? [String: Any?] {
            return [single.mapValues { ($0 as? String) ?? "asc" }]
        }
        if let pair = orderBy as? (String, String) { return [[pair.0: pair.1]] }
        return []
    }

    /// Appends one `SET` assignment, expanding the arithmetic update operators.
    public static func appendUpdateSet(
        _ setParts: inout [String],
        _ values: inout [SQLValue],
        column: String,
        value: Any?,
        dialect: Dialect
    ) {
        let quoted = dialect.quote(column)
        let placeholder = dialect.placeholder
        if let operations = value as? [String: Any?] {
            for (operation, symbol) in [("increment", "+"), ("decrement", "-"), ("multiply", "*"), ("divide", "/")] {
                if let operand = operations[operation] {
                    setParts.append("\(quoted) = \(quoted) \(symbol) \(placeholder)")
                    values.append(SQLValue.encode(operand) ?? .null)
                    return
                }
            }
            if let replacement = operations["set"] {
                setParts.append("\(quoted) = \(placeholder)")
                values.append(SQLValue.encode(replacement) ?? .null)
                return
            }
        }
        setParts.append("\(quoted) = \(placeholder)")
        values.append(SQLValue.encode(value) ?? .null)
    }

    /// Quotes a possibly schema-qualified table name.
    ///
    /// An already-bracketed name is never returned as-is: that quoting is only correct on
    /// MSSQL, so the brackets are stripped and re-applied for the target dialect instead of
    /// letting one dialect's quoting follow the name into another.
    public static func quoteTable(_ table: String, dialect: Dialect) -> String {
        var parts = splitQualified(table)
        if dialect == .sqlite, parts.count == 2, unquote(parts[0]).lowercased() == "dbo" {
            parts = Array(parts.dropFirst())
        }
        if parts.isEmpty { parts = [table] }
        return parts.map { dialect.quote($0) }.joined(separator: ".")
    }

    /// Splits `schema.table` without cutting a dot inside brackets or quotes.
    ///
    /// A plain split on `.` turns `[dbo].[users]` into two bracketed parts, which is right for
    /// MSSQL but leaves the other dialects quoting a name that already carries brackets.
    private static func splitQualified(_ table: String) -> [String] {
        var parts: [String] = []
        var buffer = ""
        var closing: Character?
        for character in table {
            if let close = closing {
                buffer.append(character)
                if character == close { closing = nil }
                continue
            }
            switch character {
            case "[": closing = "]"; buffer.append(character)
            case "\"": closing = "\""; buffer.append(character)
            case ".": parts.append(buffer); buffer = ""
            default: buffer.append(character)
            }
        }
        parts.append(buffer)
        return parts.filter { !$0.isEmpty }
    }

    private static func unquote(_ name: String) -> String {
        Dialect.strip(Dialect.strip(name, left: "[", right: "]"), left: "\"", right: "\"")
    }

    /// A bind parameter name that is a legal identifier in every dialect.
    public static func sanitizeParameterName(_ name: String) -> String {
        var cleaned = String(name.map { $0.isLetter || $0.isNumber || $0 == "_" ? $0 : "_" })
        if cleaned.isEmpty || !cleaned.first!.isLetter { cleaned = "p_" + cleaned }
        return cleaned
    }

    private static func isOperatorValue(_ value: Where) -> Bool {
        value.keys.contains { operatorKeys.contains($0) }
    }

    private static func isRelationOperatorValue(_ value: Where) -> Bool {
        value.keys.contains { relationManyKeys.contains($0) || relationOneKeys.contains($0) }
    }
}