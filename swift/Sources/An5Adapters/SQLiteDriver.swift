import Foundation
import CSQLite

/// Tells SQLite to copy a bound value rather than keep the pointer.
///
/// `SQLITE_TRANSIENT` is a C macro, and Swift cannot import those, so the same value is
/// spelled out here: `((sqlite3_destructor_type)-1)`. Without it SQLite would read freed
/// memory the moment the Swift value went out of scope.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// What a registered distance function needs to remember about itself.
private final class MetricContext {
    let metric: DistanceMetric

    init(metric: DistanceMetric) {
        self.metric = metric
    }
}

/// The SQL surface the AN5 runtime needs, so the runtime is not welded to one driver.
///
/// A protocol rather than a direct call into SQLite so an app can put its own database
/// layer underneath — GRDB, SQLite.swift, or a connection it already owns — without the
/// generated models or the query builder changing.
public protocol SQLDriver: AnyObject {
    /// Runs a query and returns its rows keyed by column name.
    func query(_ sql: String, _ parameters: [SQLValue]) throws -> [Row]

    /// Runs a statement that returns no rows and gives back the affected row count.
    @discardableResult
    func execute(_ sql: String, _ parameters: [SQLValue]) throws -> Int

    func beginTransaction() throws
    func commit() throws
    func rollback() throws
}

/// SQLite, through the system library.
///
/// The database every mobile platform already has: no bundled engine, no extra binary, and
/// the same file on device and in a simulator. One connection is held for the driver's
/// lifetime rather than opened per statement, because an in-memory database disappears when
/// its last connection closes and because per-statement connections are the wrong shape for
/// a device.
///
/// Not thread-safe: SQLite connections are not, and serialising every call would hide that
/// rather than fix it. Use one driver per thread, or an actor around one.
public final class SQLiteDriver: SQLDriver {

    private var handle: OpaquePointer?
    private let path: String

    /// Opens a database, creating the file if it does not exist.
    ///
    /// - Parameter path: a file path, `:memory:` for an in-memory database, or a `file:`
    ///   URI.
    public init(path: String) throws {
        self.path = path
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let status = sqlite3_open_v2(path, &handle, flags, nil)
        guard status == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "status \(status)"
            sqlite3_close_v2(handle)
            throw An5Error.driver("cannot open \(path): \(message)")
        }
        self.handle = handle
        // Foreign keys are off by default in SQLite, unlike every other dialect, so a schema
        // that relies on them would silently accept rows nothing points at.
        _ = try? execute("PRAGMA foreign_keys = ON", [])
        if let path = Self.sqliteVecPath {
            // An extension is optional: without it the search still ranks, through the
            // distance functions registered below or `json_each`.
            _ = sqlite3_enable_load_extension(handle, 1)
            _ = sqlite3_load_extension(handle, path, nil, nil)
            _ = sqlite3_enable_load_extension(handle, 0)
        }
        registerVectorFunctions()
    }

    /// Where to load sqlite-vec from, set before the first driver is opened.
    ///
    /// A process-wide setting on purpose: the extension belongs to the SQLite build rather
    /// than to one connection, and every AN5 connection wants the same one.
    public static var sqliteVecPath: String?

    /// Registers `an5_vec_cosine` / `an5_vec_l2` / `an5_vec_ip` so SQLite can rank a
    /// `VECTOR(n)` column without the client loading it.
    ///
    /// This runs per connection because a user function only exists for the connection that
    /// declared it.
    private func registerVectorFunctions() {
        for (metric, name) in SqliteVectors.an5Functions {
            registerVectorFunction(name, metric: metric)
        }
    }

    /// The C callback SQLite calls; it reads its arguments as pointers on a context.
    private func registerVectorFunction(_ name: String, metric: DistanceMetric) {
        // SQLite keeps the context pointer, so the metric travels with the function.
        let context = Unmanaged.passRetained(MetricContext(metric: metric)).toOpaque()
        sqlite3_create_function_v2(
            handle,
            name,
            2,
            SQLITE_UTF8 | SQLITE_DETERMINISTIC,
            context,
            { pointer, count, values in
                // A vector that cannot be scored leaves the result NULL, which the ranking
                // query filters out rather than handing to the caller.
                guard let pointer, count == 2, let values else { return }
                let metric = Unmanaged<MetricContext>.fromOpaque(pointer).takeUnretainedValue().metric
                guard let left = sqliteVecValue(values[0]),
                      let right = sqliteVecValue(values[1]),
                      left.count == right.count, !left.isEmpty else { return }
                sqlite3_result_double(pointer, DistanceMetric.distance(metric, left, right))
            },
            nil, nil, nil,
            { pointer in
                Unmanaged<MetricContext>.fromOpaque(pointer).release()
            }
        )
    }

    /// Reads one bound argument: a BLOB of float32 or a legacy JSON text column.
    private func sqliteVecValue(_ value: sqlite3_value?) -> [Double]? {
        guard let value else { return nil }
        switch sqlite3_value_type(value) {
        case SQLITE_BLOB:
            let count = Int(sqlite3_value_bytes(value))
            guard count > 0, let bytes = sqlite3_value_blob(value) else { return nil }
            return SqliteVectors.decodeBlob(Data(bytes: bytes, count: count))
        case SQLITE_TEXT:
            guard let text = sqlite3_value_text(value) else { return nil }
            return SqliteVectors.decode(String(cString: text))
        default:
            return nil
        }
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    /// The file this driver opened, for logging and diagnostics.
    public var databasePath: String { path }

    public func query(_ sql: String, _ parameters: [SQLValue]) throws -> [Row] {
        let statement = try prepare(sql, parameters)
        defer { sqlite3_finalize(statement) }

        var rows: [Row] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_ROW {
                rows.append(readRow(statement))
            } else if status == SQLITE_DONE {
                return rows
            } else {
                throw error(status, sql)
            }
        }
    }

    @discardableResult
    public func execute(_ sql: String, _ parameters: [SQLValue]) throws -> Int {
        let statement = try prepare(sql, parameters)
        defer { sqlite3_finalize(statement) }

        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_ROW || status == SQLITE_DONE {
                return Int(sqlite3_changes(handle))
            }
            throw error(status, sql)
        }
    }

    public func beginTransaction() throws {
        try execute("BEGIN", [])
    }

    public func commit() throws {
        try execute("COMMIT", [])
    }

    public func rollback() throws {
        try execute("ROLLBACK", [])
    }

    // ─── Binding ───────────────────────────────────────────────────────────────

    private func prepare(_ sql: String, _ parameters: [SQLValue]) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw error(sqlite3_errcode(handle), sql)
        }
        for (index, value) in parameters.enumerated() {
            try bind(value, to: statement, at: Int32(index + 1))
        }
        return statement
    }

    private func bind(_ value: SQLValue, to statement: OpaquePointer?, at index: Int32) throws {
        let status: Int32
        switch value {
        case .null:
            status = sqlite3_bind_null(statement, index)
        case .bool(let flag):
            status = sqlite3_bind_int64(statement, index, flag ? 1 : 0)
        case .integer(let number):
            status = sqlite3_bind_int64(statement, index, number)
        case .real(let number):
            status = sqlite3_bind_double(statement, index, number)
        case .text(let text):
            status = sqlite3_bind_text(statement, index, text, -1, SQLITE_TRANSIENT)
        case .blob(let data):
            // A zero-length blob still has to be bound with its length: passing 0 would bind
            // a NULL instead, because SQLite reads -1 as "use strlen" and 0 as "no bytes
            // and no length".
            status = data.isEmpty
                ? sqlite3_bind_zeroblob(statement, index, 0)
                : data.withUnsafeBytes { buffer in
                    sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(buffer.count), SQLITE_TRANSIENT)
                }
        case .date(let date):
            status = sqlite3_bind_double(statement, index, date.timeIntervalSince1970)
        case .uuid(let uuid):
            status = sqlite3_bind_text(statement, index, uuid.uuidString, -1, SQLITE_TRANSIENT)
        }
        guard status == SQLITE_OK else {
            throw error(status, "binding parameter \(index)")
        }
    }

    private func readRow(_ statement: OpaquePointer?) -> Row {
        var row: Row = [:]
        let columns = sqlite3_column_count(statement)
        for index in 0..<columns {
            guard let rawName = sqlite3_column_name(statement, index) else { continue }
            let name = String(cString: rawName)
            switch sqlite3_column_type(statement, index) {
            case SQLITE_INTEGER:
                row[name] = sqlite3_column_int64(statement, index)
            case SQLITE_FLOAT:
                row[name] = sqlite3_column_double(statement, index)
            case SQLITE_TEXT:
                if let text = sqlite3_column_text(statement, index) {
                    row[name] = String(cString: text)
                } else {
                    row[name] = nil
                }
            case SQLITE_BLOB:
                if let bytes = sqlite3_column_blob(statement, index) {
                    row[name] = Foundation.Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, index)))
                } else {
                    row[name] = nil
                }
            default:
                // SQLITE_NULL, and anything a newer SQLite adds: absent rather than a
                // fabricated zero, so "no value" never reads as "the value 0".
                row[name] = nil
            }
        }
        return row
    }

    private func error(_ status: Int32, _ context: String) -> An5Error {
        let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
        return .driver("\(message) — while running: \(context)")
    }
}