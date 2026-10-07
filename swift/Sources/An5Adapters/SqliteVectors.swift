import Foundation

/// SQLite vector search: the codec, the strategy plan and the ranking SQL.
///
/// SQLite has no vector type, so a `VECTOR(n)` column stores a BLOB of little-endian
/// float32 values (see ``SqliteVectors/encode(_:)``) and is ranked in one of four ways, in
/// this order:
///
/// 1. `sqlite-vec` — the extension, when it loads. Fastest, and the only option that can
///    use an ANN index.
/// 2. `udf` — `an5_vec_cosine` / `an5_vec_l2` / `an5_vec_ip` registered with the driver.
///    Reads the BLOB and the legacy JSON text.
/// 3. `sql` — `json_each` brute force in plain SQL. Needs no user function, but only
///    reaches rows stored as JSON text.
/// 4. `memory` — the column is loaded and scored in Swift.
///
/// Strategies 1-3 rank inside the database and transfer only the matching rows, which is why
/// they are preferred over the in-memory path. The bundled `SQLiteDriver` links the system
/// SQLite and can register the distance functions itself, so it reaches strategies 1-3; a
/// custom `SQLDriver` normally reaches 3 and 4.
///
/// The docstring in the TypeScript `sqlite/vector.ts` is the shared specification every
/// runtime implements.
public enum SqliteVectors {

    /// The size of one stored value; a column's byte length is its dimension times this.
    public static let bytesPerFloat = 4

    public static let strategySqliteVec = "sqlite-vec"
    public static let strategyUdf = "udf"
    public static let strategySQL = "sql"
    public static let strategyMemory = "memory"

    /// The scalar functions the adapter registers itself.
    public static let an5Functions: [String: String] = [
        "cosine": "an5_vec_cosine",
        "euclidean": "an5_vec_l2",
        "dot": "an5_vec_ip",
    ]

    /// The scalar functions the sqlite-vec extension provides.
    public static let sqliteVecFunctions: [String: String] = [
        "cosine": "vec_distance_cosine",
        "euclidean": "vec_distance_l2",
        "dot": "vec_distance_ip",
    ]

    // ─── Codec ─────────────────────────────────────────────────────────────────────

    /// Encodes a vector as the little-endian float32 BLOB the column stores.
    public static func encode(_ vector: [Double]) -> Data {
        var data = Data(capacity: vector.count * bytesPerFloat)
        for value in vector {
            withUnsafeBytes(of: Float(value).bitPattern.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }

    /// True when the value still has to become bytes on its way into a column.
    public static func needsEncoding(_ value: Any?) -> Bool {
        value is [Double] || value is [Float] || value is [NSNumber]
    }

    /// Decodes a stored vector: a float32 BLOB, a legacy JSON text column, or an array the
    /// driver already decoded.
    ///
    /// - Parameter expectedLength: the query vector's length, or `0` to accept any length.
    public static func decode(_ value: Any?, expectedLength: Int = 0) -> [Double]? {
        if let data = value as? Data {
            return decodeBlob(data, expectedLength: expectedLength)
        }
        if let bytes = value as? [UInt8] {
            return decodeBlob(Data(bytes), expectedLength: expectedLength)
        }
        return Vectors.parse(value, expectedLength: expectedLength)
    }

    /// Decodes the float32 BLOB a `VECTOR(n)` column stores.
    ///
    /// JSON text is not a multiple of four bytes once encoded and starts with `[`, so the two
    /// are told apart by length and first byte.
    public static func decodeBlob(_ data: Data, expectedLength: Int = 0) -> [Double]? {
        guard !data.isEmpty else { return nil }
        let bytes = [UInt8](data)
        if bytes[0] == UInt8(ascii: "[") || bytes.count % bytesPerFloat != 0 {
            return Vectors.parse(String(decoding: data, as: UTF8.self), expectedLength: expectedLength)
        }
        var values: [Double] = []
        values.reserveCapacity(bytes.count / bytesPerFloat)
        for offset in stride(from: 0, to: bytes.count, by: bytesPerFloat) {
            let raw = bytes[offset..<(offset + bytesPerFloat)].reduce(UInt32(0)) { $0 | (UInt32($1) << (8 * $0)) }
            values.append(Double(Float(bitPattern: raw)))
        }
        guard expectedLength == 0 || values.count == expectedLength else { return nil }
        return values
    }

    /// True when generated metadata describes a `VECTOR(n)` column.
    public static func isVectorField(_ field: FieldMeta) -> Bool {
        isVectorType(field.sqlType) || isVectorType(field.type)
    }

    /// True when a declared SQL type names a vector column.
    public static func isVectorType(_ sql: String?) -> Bool {
        guard let sql, !sql.isEmpty else { return false }
        let trimmed = sql.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("[]") { return true }
        let upper = trimmed.uppercased()
        guard upper.hasPrefix("VECTOR") else { return false }
        let rest = String(upper.dropFirst("VECTOR".count))
        return rest.isEmpty || rest.hasPrefix("(") || rest.hasPrefix(" ")
    }

    // ─── Strategy plan ─────────────────────────────────────────────────────────────

    /// What a connection can do, probed once and cached by the driver.
    public struct Capabilities: Sendable {
        /// `vec_version()` answered, so the sqlite-vec extension is loaded.
        public var vec: Bool
        /// The adapter's own distance functions are registered.
        public var udf: Bool
        /// `json_each()` is available, which the pure-SQL strategy needs.
        public var json1: Bool

        public init(vec: Bool = false, udf: Bool = false, json1: Bool = false) {
            self.vec = vec
            self.udf = udf
            self.json1 = json1
        }
    }

    /// The ordered strategies to try.
    ///
    /// `declaredType` is the column's DDL type: the JSON strategy only reaches rows stored
    /// as text, so a `BLOB` column drops it from the order.
    public static func plan(
        capabilities: Capabilities,
        declaredType: String?,
        preference: String?
    ) -> [String] {
        if let preference, !preference.isEmpty, preference != "auto" {
            // `memory` is the caller's own path, not a query, so it yields no plan.
            return preference == strategyMemory ? [] : [preference]
        }
        var available: [String] = []
        if capabilities.vec { available.append(strategySqliteVec) }
        if capabilities.udf { available.append(strategyUdf) }
        if capabilities.json1 { available.append(strategySQL) }
        let declared = (declaredType ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let textLike = ["TEXT", "CHAR", "CLOB", "STRING", "JSON"].contains { declared.contains($0) }
        if !declared.isEmpty && !textLike {
            // A BLOB column has no JSON to read, so json_each could only produce NULLs.
            available.removeAll { $0 == strategySQL }
        }
        return available
    }

    // ─── Query building ─────────────────────────────────────────────────────────────

    /// `json_valid` fails on a float32 BLOB, so the JSON path needs this guard.
    private static func jsonText(_ column: String) -> String {
        "CASE WHEN json_valid(\(column)) THEN \(column) ELSE '[]' END"
    }

    private static func jsonDistanceExpr(metric: DistanceMetric, _ column: String) -> String {
        let row = jsonText(column)
        let sameLength = "(SELECT COUNT(*) FROM json_each(\(row))) = (SELECT COUNT(*) FROM q)"
        let terms: String
        switch metric {
        case .euclidean:
            terms = "sqrt((SELECT SUM((je.value - q.v) * (je.value - q.v))"
                + " FROM json_each(\(row)) je JOIN q ON q.k = je.key))"
        case .dot:
            terms = "-(SELECT SUM(je.value * q.v) FROM json_each(\(row)) je JOIN q ON q.k = je.key)"
        case .cosine:
            terms = "1.0 - (SELECT SUM(je.value * q.v) FROM json_each(\(row)) je JOIN q ON q.k = je.key)"
                + " / NULLIF(sqrt((SELECT SUM(q.v * q.v) FROM q))"
                + " * sqrt((SELECT SUM(je.value * je.value) FROM json_each(\(row)) je)), 0)"
        }
        return "CASE WHEN \(sameLength) THEN \(terms) END"
    }

    /// The ranking SQL for one strategy, with the values its placeholders need appended.
    ///
    /// `sqlite-vec` and `udf` bind the query vector as a float32 BLOB; `sql` binds it as
    /// JSON text because `json_each` reads text.
    ///
    /// A row whose stored vector cannot be scored (a `NULL`, a text column, another
    /// dimension) yields a `NULL` distance; those rows are dropped rather than reported, so
    /// a caller never has to sort them out of the result.
    public static func rankingQuery(
        strategy: String,
        metric: DistanceMetric,
        table: String,
        column: String,
        vector: [Double],
        take: Int,
        tail: String,
        placeholder: String,
        bind: inout [SQLValue]
    ) -> String? {
        let functions = strategy == strategySqliteVec ? sqliteVecFunctions : an5Functions
        var inner: String
        if strategy == strategySqliteVec || strategy == strategyUdf {
            guard let function = functions[metric.rawValue] else { return nil }
            let distance = "\(function)(\(column), \(placeholder))"
            var guardClause = ""
            if strategy == strategySqliteVec {
                // sqlite-vec only understands float32 BLOB operands, so rows stored any other
                // way are excluded instead of aborting the query. The guard joins the caller's
                // WHERE with AND, since appending the tail after it would produce a second
                // WHERE.
                guardClause = "typeof(\(column)) = 'blob' AND length(\(column)) = \(placeholder)"
                bind.append(.blob(encode(vector)))
                bind.append(.integer(Int64(vector.count * bytesPerFloat)))
            } else {
                bind.append(.blob(encode(vector)))
            }
            if guardClause.isEmpty {
                inner = "SELECT *, \(distance) AS distance FROM \(table)\(tail)"
            } else if tail.isEmpty {
                inner = "SELECT *, \(distance) AS distance FROM \(table) WHERE \(guardClause)"
            } else {
                let trimmed = tail.drop(while: { $0 == " " })
                inner = "SELECT *, \(distance) AS distance FROM \(table)"
                    + " WHERE \(guardClause) AND \(trimmed)"
            }
        } else {
            bind.append(.text(Vectors.format(vector)))
            inner = "SELECT *, \(jsonDistanceExpr(metric: metric, column)) AS distance"
                + " FROM \(table)\(tail)"
            inner = "WITH q AS (SELECT je.key AS k, CAST(je.value AS REAL) AS v"
                + " FROM json_each(\(placeholder)) je) " + inner
        }
        return "SELECT * FROM (\(inner)) AS an5_ranked"
            + " WHERE distance IS NOT NULL ORDER BY distance ASC LIMIT \(take)"
    }
}
