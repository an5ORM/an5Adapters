import Foundation

/// A query's filters, ordering, paging, projection and eager loads.
///
/// Every field has a default, so `Query()` means the same thing an omitted filter means in
/// the other adapters: no filter, no order, no limit.
public struct Query {

    public var filter: Where?
    public var orderBy: [[String: String]]
    public var skip: Int
    public var take: Int?
    public var select: [String]?
    public var include: Include?

    public init(
        filter: Where? = nil,
        orderBy: [[String: String]] = [],
        skip: Int = 0,
        take: Int? = nil,
        select: [String]? = nil,
        include: Include? = nil
    ) {
        self.filter = filter
        self.orderBy = orderBy
        self.skip = max(0, skip)
        self.take = take
        self.select = select
        self.include = include
    }

    /// The same query with a row cap, leaving the caller's query untouched.
    ///
    /// Mutating it instead would silently cap every later use of the value, so a
    /// `findFirst` would quietly limit a caller's subsequent `findMany`.
    public func limited(to take: Int?) -> Query {
        var copy = self
        copy.take = take
        return copy
    }

    // ─── Filter building ────────────────────────────────────────────────────────
    // Named after the operators they produce rather than Swift's own vocabulary, so a
    // filter reads the same in Swift as it does in every other AN5 client.

    /// `"age" >= 18`
    public static func gte(_ column: String, _ value: Any?) -> Where { [column: ["gte": value]] }
    /// `"age" <= 18`
    public static func lte(_ column: String, _ value: Any?) -> Where { [column: ["lte": value]] }
    /// `"age" > 18`
    public static func gt(_ column: String, _ value: Any?) -> Where { [column: ["gt": value]] }
    /// `"age" < 18`
    public static func lt(_ column: String, _ value: Any?) -> Where { [column: ["lt": value]] }
    /// `"name" == "Ada"`
    public static func equals(_ column: String, _ value: Any?) -> Where { [column: ["equals": value]] }
    /// `"name" != "Ada"`
    public static func not(_ column: String, _ value: Any?) -> Where { [column: ["not": value]] }
    /// `"name" contains "da"`
    public static func contains(_ column: String, _ value: String) -> Where { [column: ["contains": value]] }
    /// `"name" startsWith "Ad"`
    public static func startsWith(_ column: String, _ value: String) -> Where { [column: ["startsWith": value]] }
    /// `"name" endsWith "ce"`
    public static func endsWith(_ column: String, _ value: String) -> Where { [column: ["endsWith": value]] }
    /// `"id"` is `NULL`.
    public static func isNull(_ column: String) -> Where { [column: NSNull()] }
    /// `"id"` is not `NULL`.
    public static func isNotNull(_ column: String) -> Where { [column: ["not": NSNull()]] }
    /// `"id"` in `values`; an empty list matches nothing.
    public static func `in`(_ column: String, _ values: [Any?]) -> Where { [column: ["in": values]] }
    /// `"id"` not in `values`; an empty list matches everything.
    public static func notIn(_ column: String, _ values: [Any?]) -> Where { [column: ["notIn": values]] }

    /// Any of `filters`; an empty list matches nothing.
    public static func or(_ filters: Where...) -> Where { ["OR": filters] }
    /// All of `filters`; an empty list matches everything.
    public static func and(_ filters: Where...) -> Where { ["AND": filters] }
    /// None of `filters`; an empty list matches everything.
    public static func not(_ filters: Where...) -> Where { ["NOT": filters] }
}

/// Which aggregates a query computes.
///
/// One type covers both a flat aggregate and a grouped one, because the metrics are the
/// same; `by` is what makes it a group.
public struct Aggregate {
    public var count = false
    public var sum: [String] = []
    public var average: [String] = []
    public var minimum: [String] = []
    public var maximum: [String] = []
    public var filter: Where?
    public var by: [String] = []
    public var orderBy: [[String: String]] = []
    public var skip = 0
    public var take: Int?

    public init() {}

    public var isEmpty: Bool { !count && sum.isEmpty && average.isEmpty && minimum.isEmpty && maximum.isEmpty }
}

public enum SortDirection: String, Sendable {
    case asc = "ASC"
    case desc = "DESC"
}