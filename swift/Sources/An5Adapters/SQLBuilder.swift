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
        "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt",
    ]

    /// Builds the `WHERE` clause and the parameters it binds, in order.
    ///
    /// Every value reaches the database as a bind parameter; none is ever formatted into the
    /// SQL. `AND`/`OR`/`NOT` groups are supported, and an empty `in: []` becomes `1=0` rather
    /// than the invalid `IN ()`.
    public static func whereClause(_ filter: Where?, dialect: Dialect, prefix: String = "") -> WhereClause {
        guard let filter, !filter.isEmpty else { return WhereClause() }

        // A key with an underscore whose value is a map of plain columns is a flattened
        // relation filter; hoisting it puts those conditions alongside the rest instead of
        // quoting the whole thing as one column name.
        var flattened: [String: Any?] = [:]
        for (key, value) in filter {
            if key.contains("_"), let nested = value as? Where, !isOperatorValue(nested) {
                for (nestedKey, nestedValue) in nested { flattened[nestedKey] = nestedValue }
            } else {
                flattened[key] = value
            }
        }

        var conditions: [String] = []
        var parameters: [SQLValue] = []
        for (key, value) in flattened {
            switch key {
            case "OR":
                guard let branches = value as? [Where] else { continue }
                var sub: [String] = []
                for (index, branch) in branches.enumerated() {
                    let clause = self.whereClause(branch, dialect: dialect, prefix: "\(prefix)or\(index)_")
                    sub.append(clause.isEmpty ? "1=1" : clause.sql)
                    parameters.append(contentsOf: clause.parameters)
                }
                conditions.append(sub.isEmpty ? "1=0" : "(\(sub.joined(separator: " OR ")))")
            case "AND":
                let items = value as? [Where] ?? [value as? Where ?? [:]]
                var sub: [String] = []
                for (index, item) in items.enumerated() {
                    let clause = self.whereClause(item, dialect: dialect, prefix: "\(prefix)and\(index)_")
                    parameters.append(contentsOf: clause.parameters)
                    if !clause.isEmpty { sub.append(clause.sql) }
                }
                if !sub.isEmpty { conditions.append("(\(sub.joined(separator: " AND ")))") }
            case "NOT":
                let items = value as? [Where] ?? [value as? Where ?? [:]]
                var sub: [String] = []
                for (index, item) in items.enumerated() {
                    let clause = self.whereClause(item, dialect: dialect, prefix: "\(prefix)not\(index)_")
                    sub.append(clause.isEmpty ? "1=1" : clause.sql)
                    parameters.append(contentsOf: clause.parameters)
                }
                if !sub.isEmpty { conditions.append("NOT (\(sub.joined(separator: " OR ")))") }
            default:
                conditions.append(
                    condition(key: key, value: value, dialect: dialect, prefix: prefix, parameters: &parameters)
                )
            }
        }
        return WhereClause(sql: conditions.filter { !$0.isEmpty }.joined(separator: " AND "), parameters: parameters)
    }

    private static func condition(
        key: String,
        value: Any?,
        dialect: Dialect,
        prefix: String,
        parameters: inout [SQLValue]
    ) -> String {
        let column = dialect.quote(key)
        let placeholder = dialect.placeholder

        if value == nil || value is NSNull {
            return "\(column) IS NULL"
        }
        guard let operators = value as? Where else {
            parameters.append(SQLValue.encode(value) ?? .null)
            return "\(column) = \(placeholder)"
        }

        var conditions: [String] = []
        if let inner = operators["not"] {
            if inner == nil || inner is NSNull {
                conditions.append("\(column) IS NOT NULL")
            } else if let nested = inner as? Where {
                let clause = self.whereClause([key: nested], dialect: dialect, prefix: prefix + key + "_not_")
                parameters.append(contentsOf: clause.parameters)
                if !clause.isEmpty { conditions.append("NOT (\(clause.sql))") }
            } else {
                parameters.append(SQLValue.encode(inner) ?? .null)
                conditions.append("\(column) <> \(placeholder)")
            }
        }
        if operators.keys.contains("equals") {
            // Flattened: a lookup on a `[String: Any?]` yields `Any??`, and letting the
            // compiler coerce it is how a `NULL` operand stops reading as "is null".
            let equals = operators["equals"] ?? nil
            if equals == nil || equals is NSNull {
                conditions.append("\(column) IS NULL")
            } else {
                parameters.append(SQLValue.encode(equals) ?? .null)
                conditions.append("\(column) = \(placeholder)")
            }
        }
        for (op, template) in [("contains", "%@%"), ("startsWith", "@%"), ("endsWith", "%@")] {
            guard let operand = operators[op] else { continue }
            // Rendered through `encode` rather than interpolated directly: a filter built
            // from a `[String: Any?]` dictionary hands the operand over wrapped in an
            // `Optional`, and interpolating that would search for the text "Optional(da)".
            parameters.append(.text(template.replacingOccurrences(of: "@", with: literal(operand))))
            conditions.append("\(column) LIKE \(placeholder)")
        }
        for (op, sql) in [("gte", ">="), ("lte", "<="), ("gt", ">"), ("lt", "<")] {
            guard let operand = operators[op] else { continue }
            parameters.append(SQLValue.encode(operand) ?? .null)
            conditions.append("\(column) \(sql) \(placeholder)")
        }
        for (op, sql, emptyResult) in [("in", " IN (", "1=0"), ("notIn", " NOT IN (", "1=1")] {
            guard let raw = operators[op] else { continue }
            // Accepts an untyped list whatever element type it was built with: a caller that
            // wrote `["Ada", "Grace"]` produced a `[String]`, and a cast straight to
            // `[Any?]` does not always see through that, which would silently turn an
            // `in` filter into "match nothing".
            let values: [Any?]
            if let typed = raw as? [Any?] {
                values = typed
            } else if let list = raw as? [Any] {
                values = list.map { $0 }
            } else {
                values = []
            }
            if values.isEmpty {
                // `IN ()` is a syntax error in every dialect. An empty set can match nothing,
                // so it becomes 1=0; the negated form is true of every row, so 1=1.
                conditions.append(emptyResult)
                continue
            }
            conditions.append(column + sql + values.map { _ in placeholder }.joined(separator: ", ") + ")")
            parameters.append(contentsOf: values.map { SQLValue.encode($0) ?? .null })
        }
        return conditions.joined(separator: " AND ")
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
}