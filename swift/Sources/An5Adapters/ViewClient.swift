import Foundation

/// A read-only client for a database view.
///
/// Reads go straight to the underlying table client, which already knows how to select from
/// an arbitrary name. Every mutation is refused rather than attempted: a view has no rows to
/// write, and the databases disagree about whether the statement is even legal, so the error
/// is raised here where it can name the reason.
public struct ViewClient {

    public let adapter: An5Adapter
    public let view: String

    private var client: TableClient { adapter.table(view) }

    public init(adapter: An5Adapter, view: String) {
        self.adapter = adapter
        self.view = view
    }

    public func findMany() throws -> [Row] { try client.findMany() }
    public func findMany(_ query: Query) throws -> [Row] { try client.findMany(query) }
    public func findMany(filter: Where) throws -> [Row] { try client.findMany(filter: filter) }
    public func findFirst(filter: Where) throws -> Row? { try client.findFirst(filter: filter) }
    public func findUnique(filter: Where) throws -> Row? { try client.findUnique(filter: filter) }
    public func count(_ filter: Where? = nil) throws -> Int { try client.count(filter) }
    public func aggregate(_ aggregate: Aggregate) throws -> Row { try client.aggregate(aggregate) }
    public func groupBy(_ aggregate: Aggregate) throws -> [Row] { try client.groupBy(aggregate) }

    public func vectorSearch(
        _ vector: [Double],
        take: Int = 10,
        filter: Where? = nil,
        vectorField: String = "embedding",
        metric: DistanceMetric = .cosine
    ) throws -> [Row] {
        try client.vectorSearch(vector, take: take, filter: filter, vectorField: vectorField, metric: metric)
    }

    public func create(_ data: Values) throws -> Row { throw readOnly("create") }
    public func update(filter: Where, data: Values) throws -> Row? { throw readOnly("update") }
    public func updateMany(filter: Where?, data: Values) throws -> Int { throw readOnly("updateMany") }
    public func delete(filter: Where) throws -> Row? { throw readOnly("delete") }
    public func deleteMany(filter: Where? = nil) throws -> Int { throw readOnly("deleteMany") }
    public func upsert(filter: Where, create: Values, update: Values) throws -> Row { throw readOnly("upsert") }

    private func readOnly(_ operation: String) -> An5Error {
        .readOnly("view '\(view)' — \(operation) is not allowed on it")
    }
}
