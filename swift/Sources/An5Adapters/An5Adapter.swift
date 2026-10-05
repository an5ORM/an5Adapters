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
