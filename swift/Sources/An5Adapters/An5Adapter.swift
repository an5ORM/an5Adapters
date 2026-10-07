import Foundation

/// The AN5 runtime: a driver, the dialect it speaks, and the metadata that gives models
/// their tables.
///
/// ```swift
/// let driver = try SQLiteDriver(path: ":memory:")
/// let db = try An5Adapter(driver: driver, connectionString: "sqlite::memory:", metadata: An5Metadata.registry)
/// try db.table("User").create(["name": "Ada", "score": 10])
/// let adults = try db.table("User").findMany(where: ["age": ["gte": 18]])
/// ```
///
/// One connection is held for its lifetime, so an in-memory database survives between
/// statements — which is what makes it usable in a test.
public final class An5Adapter {

    public let driver: SQLDriver
    public let dialect: Dialect
    public let metadata: Metadata

    /// The open transaction, when there is one. Every statement inside it has to use this
    /// driver's single connection, which is why the flag exists at all: a rollback that ran
    /// on a different connection would return to an already committed one.
    ///
    /// Shared with the scoped adapter `transaction` hands to the caller, so a nested
    /// transaction is refused no matter which handle the inner call went through.
    private var state = TransactionState()

    /// Opens a runtime over an existing driver.
    ///
    /// - Parameters:
    ///   - driver: the SQL surface to run statements through.
    ///   - connectionString: the project's connection string; decides the dialect.
    ///   - metadata: the generated models' tables and columns.
    public convenience init(driver: SQLDriver, connectionString: String, metadata: Metadata = .empty) {
        self.init(driver: driver, dialect: Dialect.detect(connectionString), metadata: metadata)
    }

    /// Opens a runtime when the dialect is already known.
    ///
    /// Separate from the connection-string form because re-deriving the dialect from a bare
    /// name like `sqlite` does not work: `Dialect.detect` reads a scheme or a file suffix,
    /// and neither is present, so it falls through to SQL Server and every statement in a
    /// transaction comes out with `WITH (NOLOCK)`.
    init(driver: SQLDriver, dialect: Dialect, metadata: Metadata = .empty) {
        self.driver = driver
        self.dialect = dialect
        self.metadata = metadata
    }

    /// Opens a runtime over the system SQLite.
    public convenience init(
        path: String,
        metadata: Metadata = .empty,
        connectionString: String? = nil
    ) throws {
        try self.init(
            driver: SQLiteDriver(path: path),
            connectionString: connectionString ?? "sqlite::memory:",
            metadata: metadata
        )
    }

    /// A runtime over the same driver that shares this one's transaction state.
    private func scoped() -> An5Adapter {
        let scoped = An5Adapter(driver: driver, dialect: dialect, metadata: metadata)
        scoped.state = state
        return scoped
    }

    /// The table client for a model.
    public func table(_ model: String) -> TableClient {
        TableClient(adapter: self, model: model)
    }

    /// A read-only client for a database view.
    public func view(_ name: String) -> ViewClient {
        ViewClient(adapter: self, view: name)
    }

    /// Pins one SQLite vector strategy instead of probing for the fastest one available:
    /// `sqlite-vec`, `udf`, `sql` or `memory`. `nil` probes.
    ///
    /// SQLite has no vector type, so a `VECTOR(n)` column is ranked by the sqlite-vec
    /// extension, a distance function the driver registers, `json_each` in plain SQL, or in
    /// the client. The bundled `SQLiteDriver` registers the distance functions and loads
    /// `SQLiteDriver.sqliteVecPath` when one is set.
    public var vectorStrategy: String?

    /// What this SQLite connection can do for vector search, probed once and cached.
    ///
    /// `nil` on the other dialects. The bundled driver registers the `an5_vec_*` functions
    /// itself, so `udf` is reported whenever it is in use; a custom `SQLDriver` normally
    /// reaches only `json_each` and the in-memory path.
    public private(set) lazy var sqliteCapabilities: SqliteVectors.Capabilities = {
        SqliteVectors.Capabilities(
            vec: self.probe("SELECT vec_version()"),
            udf: self.probe("SELECT an5_vec_cosine(zeroblob(4), zeroblob(4))"),
            json1: self.probe("SELECT json_valid('[1]')")
        )
    }()

    /// True when a probe statement ran, whatever it returned.
    private func probe(_ sql: String) -> Bool {
        (try? driver.query(sql, [])) != nil
    }

    /// A vector column's declared DDL type, or `nil` when it cannot be read.
    ///
    /// It is what decides whether the `json_each` strategy can reach the rows in the column:
    /// a `BLOB` column has no JSON to walk.
    public func queryColumnType(table: String, column: String) throws -> String? {
        let rows = try driver.query(
            "SELECT type FROM pragma_table_info(?) WHERE name = ?", [.text(table), .text(column)]
        )
        return rows.first?["type"].flatMap { $0 as? String }
    }

    /// Runs a query and returns its rows keyed by column name.
    public func query(_ sql: String, _ parameters: [Any?] = []) throws -> [Row] {
        try driver.query(sql, parameters.compactMap { SQLValue.encode($0) })
    }

    /// Runs a statement that returns no rows and gives back the affected row count.
    @discardableResult
    public func execute(_ sql: String, _ parameters: [Any?] = []) throws -> Int {
        try driver.execute(sql, parameters.compactMap { SQLValue.encode($0) })
    }

    /// Runs `body` inside a transaction, committing on return and rolling back on failure.
    ///
    /// Nesting is rejected rather than flattened: an inner commit would make the outer
    /// rollback a partial save, which is the opposite of what the caller asked for.
    public func transaction<T>(_ body: (An5Adapter) throws -> T) throws -> T {
        guard !state.inTransaction else {
            throw An5Error.invalidQuery("a nested transaction is not supported")
        }
        state.inTransaction = true
        defer { state.inTransaction = false }
        do {
            try driver.beginTransaction()
        } catch {
            throw An5Error.driver("cannot begin a transaction: \(error)")
        }
        do {
            let result = try body(scoped())
            try driver.commit()
            return result
        } catch {
            try? driver.rollback()
            throw error
        }
    }
}

/// Whether a transaction is open, shared between an adapter and the scoped handle its
/// transaction hands out.
private final class TransactionState {
    var inTransaction = false
}
