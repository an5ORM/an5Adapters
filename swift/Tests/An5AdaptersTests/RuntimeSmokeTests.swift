import Foundation
import XCTest
@testable import An5Adapters

/// End-to-end exercise of the Swift runtime against a real in-memory SQLite database.
///
/// Covers what a compile check cannot: that the generated SQL is valid for the driver, that
/// generated primary keys come back, that nested relation writes land, that a rollback
/// really discards, and that the in-memory vector fallback ranks correctly.
final class RuntimeSmokeTests: XCTestCase {

    private func makeAdapter() throws -> An5Adapter {
        let adapter = try An5Adapter(path: ":memory:", metadata: Self.metadata)
        try adapter.execute("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, score INTEGER, nickname TEXT)")
        try adapter.execute("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, userId TEXT)")
        try adapter.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding TEXT)")
        return adapter
    }

    // MARK: - Dialects, quoting and URLs

    func testDialectDetection() {
        XCTAssertEqual(Dialect.detect("Server=db;Database=app"), .mssql)
        XCTAssertEqual(Dialect.detect("postgresql://localhost/app"), .postgres)
        XCTAssertEqual(Dialect.detect("sqlite:///tmp/app.db"), .sqlite)
        XCTAssertEqual(Dialect.detect("/tmp/app.sqlite3"), .sqlite)
        XCTAssertEqual(Dialect.detect(":memory:"), .sqlite)
    }

    func testQuoting() {
        XCTAssertEqual(Dialect.mssql.quote("name"), "[name]")
        XCTAssertEqual(Dialect.mssql.quote("we]ird"), "[we]]ird]")
        XCTAssertEqual(Dialect.sqlite.quote("[name]"), "\"name\"")
        XCTAssertEqual(Dialect.postgres.quote("we\"ird"), "\"we\"\"ird\"")
        XCTAssertEqual(SQLBuilder.quoteTable("dbo.users", dialect: .sqlite), "\"users\"")
        XCTAssertEqual(SQLBuilder.quoteTable("dbo.users", dialect: .mssql), "[dbo].[users]")
    }

    func testPagination() {
        XCTAssertEqual(Dialect.sqlite.pagination(take: 10, skip: 5, orderBy: "ORDER BY id"), " LIMIT 10 OFFSET 5")
        XCTAssertEqual(
            Dialect.mssql.pagination(take: 10, skip: 5, orderBy: "ORDER BY id"),
            " OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY"
        )
        XCTAssertEqual(
            Dialect.mssql.pagination(take: 10, skip: 5, orderBy: ""),
            " ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY"
        )
        XCTAssertEqual(Dialect.sqlite.pagination(take: nil, skip: 5, orderBy: ""), "")
    }

    // MARK: - Vectors

    func testVectors() {
        XCTAssertEqual(Vectors.cosineSimilarity([1, 2], [1, 2]), 1.0, accuracy: 1e-9)
        XCTAssertEqual(Vectors.cosineSimilarity([1, 0], [-1, 0]), -1.0, accuracy: 1e-9)
        XCTAssertEqual(Vectors.cosineSimilarity([1], [1, 2]), 0)
        XCTAssertEqual(Vectors.euclideanDistance([0, 0], [3, 4]), 5.0, accuracy: 1e-9)
        XCTAssertEqual(Vectors.dotProduct([1, 2], [3, 4]), 11.0, accuracy: 1e-9)
        XCTAssertEqual(DistanceMetric.distance(.dot, [1, 2], [3, 4]), -11.0, accuracy: 1e-9)
        XCTAssertEqual(Vectors.parse("[1.0, 2.0, 3.0]", expectedLength: 3)?.count, 3)
        XCTAssertNil(Vectors.parse("[1.0, 2.0]", expectedLength: 3))
        XCTAssertEqual(Vectors.format([1.0, 2.5]), "[1.0, 2.5]")
    }

    // MARK: - CRUD

    func testCrud() throws {
        let adapter = try makeAdapter()
        let users = adapter.table("User")

        let created = try users.create(["name": "Ada", "score": 10])
        let id = try XCTUnwrap(created["id"] as? String)
        XCTAssertFalse(id.isEmpty, "a model with an @id column gets a generated key")
        XCTAssertEqual(created["name"] as? String, "Ada")

        XCTAssertEqual(try users.count(), 1)
        try users.createMany([
            ["name": "Grace", "score": 20],
            ["name": "Alan", "score": 30],
        ])

        var ordered = Query()
        ordered.orderBy = [["score": "desc"]]
        XCTAssertEqual(try users.findMany(ordered).first?["name"] as? String, "Alan")

        var paged = Query()
        paged.orderBy = [["score": "asc"]]
        paged.skip = 1
        paged.take = 1
        let page = try users.findMany(paged)
        XCTAssertEqual(page.count, 1)
        XCTAssertEqual(page.first?["name"] as? String, "Grace")

        XCTAssertEqual(try users.findMany(filter: Query.gte("score", 20)).count, 2)
        XCTAssertEqual(try users.findMany(filter: Query.lt("score", 20)).count, 1)
        XCTAssertEqual(try users.findMany(filter: Query.equals("name", "Ada")).count, 1)
        XCTAssertEqual(try users.findMany(filter: Query.contains("name", "da")).count, 1)
        XCTAssertEqual(try users.findMany(filter: Query.endsWith("name", "ce")).count, 1)
        XCTAssertEqual(try users.findMany(filter: Query.in("name", ["Ada", "Grace"])).count, 2)
        XCTAssertEqual(try users.findMany(filter: Query.`in`("name", [])).count, 0)
        XCTAssertEqual(try users.findMany(filter: Query.notIn("name", [])).count, 3)
        XCTAssertEqual(
            try users.findMany(filter: Query.or(Query.equals("name", "Ada"), Query.equals("name", "Alan"))).count,
            2
        )
        XCTAssertEqual(
            try users.findMany(filter: Query.and(Query.gte("score", 10), Query.lte("score", 20))).count,
            2
        )
        XCTAssertEqual(
            try users.findMany(filter: Query.not(Query.equals("name", "Ada"), Query.equals("name", "Grace"))).count,
            1
        )
        XCTAssertEqual(try users.findMany(filter: Query.or()).count, 0)
        XCTAssertEqual(try users.findMany(filter: Query.isNull("nickname")).count, 3)

        var projection = Query()
        projection.select = ["name"]
        let selected = try users.findMany(projection)
        XCTAssertEqual(selected.first?.keys.sorted(), ["name"])

        XCTAssertEqual(
            try users.update(filter: ["id": id], data: ["score": ["increment": 5]])?["score"] as? Int64,
            15
        )
        XCTAssertEqual(try users.updateMany(filter: nil, data: ["score": ["increment": 1]]), 3)
        XCTAssertEqual(
            try users.upsert(filter: ["id": id], create: ["name": "x"], update: ["name": "Ada L"])["name"] as? String,
            "Ada L"
        )
        XCTAssertEqual(try users.count(), 3)
        try users.upsert(filter: ["name": "Katherine"], create: ["name": "Katherine"], update: ["name": "K"])
        XCTAssertEqual(try users.count(), 4)

        XCTAssertEqual(try users.delete(filter: ["id": id])?["name"] as? String, "Ada L")
        XCTAssertEqual(try users.count(), 3)
        XCTAssertEqual(try users.deleteMany(), 3)
        XCTAssertEqual(try users.count(), 0)
    }

    // MARK: - Aggregation

    func testAggregation() throws {
        let adapter = try makeAdapter()
        let users = adapter.table("User")
        try users.createMany([
            ["name": "Ada", "score": 10],
            ["name": "Grace", "score": 20],
            ["name": "Alan", "score": 30],
        ])

        var totals = Aggregate()
        totals.count = true
        totals.sum = ["score"]
        totals.average = ["score"]
        totals.maximum = ["score"]
        let aggregate = try users.aggregate(totals)
        XCTAssertEqual((aggregate["_count"] as? NSNumber)?.intValue, 3)
        XCTAssertEqual((aggregate["_sum_score"] as? NSNumber)?.doubleValue, 60.0)
        XCTAssertEqual((aggregate["_avg_score"] as? NSNumber)?.doubleValue, 20.0)
        XCTAssertEqual((aggregate["_max_score"] as? NSNumber)?.doubleValue, 30.0)

        var filtered = Aggregate()
        filtered.count = true
        filtered.filter = Query.gte("score", 20)
        XCTAssertEqual(((try users.aggregate(filtered)["_count"]) as? NSNumber)?.intValue, 2)

        var groups = Aggregate()
        groups.by = ["name"]
        groups.sum = ["score"]
        let grouped = try users.groupBy(groups)
        XCTAssertEqual(grouped.count, 3)
        XCTAssertTrue(grouped.allSatisfy { ($0["_count"] as? NSNumber)?.intValue == 1 })

        let empty = Aggregate()
        XCTAssertThrowsError(try users.groupBy(empty))
        XCTAssertThrowsError(try users.aggregate(Aggregate()))
    }

    // MARK: - Relations

    func testRelations() throws {
        let adapter = try makeAdapter()
        let ada = try adapter.table("User").create(["name": "Ada", "score": 1])
        let adaId = try XCTUnwrap(ada["id"] as? String)
        try adapter.table("Post").create(["title": "first", "userId": adaId])
        try adapter.table("Post").create(["title": "second", "userId": adaId])

        var query = Query()
        query.orderBy = [["name": "asc"]]
        query.include = ["posts": true, "_count": true]
        let rows = try adapter.table("User").findMany(query)
        let first = try XCTUnwrap(rows.first)

        let posts = try XCTUnwrap(first["posts"] as? [Row])
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts.first?["title"] as? String, "first")
        XCTAssertEqual((first["_count"] as? [String: Int])?["posts"], 2)

        try adapter.table("User").create([
            "name": "Barbara",
            "posts": ["create": ["title": "third"]],
        ])
        XCTAssertEqual(try adapter.table("Post").count(), 3)
    }

    // MARK: - Transactions

    func testTransactionRollback() throws {
        let adapter = try makeAdapter()
        let users = adapter.table("User")
        try users.create(["name": "outside"])

        struct Boom: Error {}
        XCTAssertThrowsError(
            _ = try adapter.transaction { scoped in
                try scoped.table("User").create(["name": "inside"])
                throw Boom()
            }
        )
        XCTAssertEqual(try users.count(), 1, "a rollback discards the inner insert")

        _ = try adapter.transaction { scoped in
            try scoped.table("User").create(["name": "committed"])
        }
        XCTAssertEqual(try users.count(), 2)

        XCTAssertThrowsError(
            _ = try adapter.transaction { scoped in
                try scoped.transaction { _ in }
            },
            "a nested transaction is refused rather than silently flattened"
        )
    }

    // MARK: - Views and vector search

    func testViewIsReadOnly() throws {
        let adapter = try makeAdapter()
        try adapter.table("User").create(["name": "Ada", "score": 1])
        let view = adapter.view("User")
        XCTAssertEqual(try view.count(), 1)
        XCTAssertEqual(try view.findMany().count, 1)
        XCTAssertThrowsError(try view.create(["name": "x"])) { error in
            guard case .readOnly = error as? An5Error else {
                return XCTFail("expected a read-only error, got \(error)")
            }
        }
    }

    func testVectorFallback() throws {
        let adapter = try makeAdapter()
        let documents = adapter.table("Document")
        // Orthogonal to the query: cosine distance is scale-invariant, so a longer vector
        // pointing the same way would still rank as the closest.
        try documents.create(["title": "far", "embedding": "[0.0, 1.0]"])
        try documents.create(["title": "near", "embedding": "[1.0, 0.1]"])
        try documents.create(["title": "no vector", "embedding": NSNull()])

        let hits = try documents.vectorSearch([1.0, 0.0], take: 2)
        XCTAssertEqual(hits.count, 2, "rows without a vector are skipped")
        XCTAssertEqual(hits.first?["title"] as? String, "near")
        XCTAssertNotNil(hits.first?["distance"] as Any?)
    }

    // MARK: - SQLite vector search

    /// The bundled driver registers the `an5_vec_*` functions and can load sqlite-vec, so a
    /// `VECTOR(n)` column is ranked inside the database.
    ///
    /// The docstring in `SqliteVectors` is the shared specification every runtime implements;
    /// test/sqlite-vector.test.js (TypeScript) is the mirror of this coverage.
    func testSqliteVectorCodecAndPlan() {
        let encoded = SqliteVectors.encode([1, -2, 0.5])
        XCTAssertEqual(encoded.count, 12, "float32 per value")
        XCTAssertEqual(Array(encoded.prefix(4)), [0x00, 0x00, 0x80, 0x3F], "little-endian 1.0")
        XCTAssertEqual(SqliteVectors.decodeBlob(encoded) ?? [], [1, -2, 0.5])
        XCTAssertEqual(SqliteVectors.decode("[1, 0, 0]") ?? [], [1, 0, 0], "legacy JSON text")
        XCTAssertEqual(SqliteVectors.decode(encoded, expectedLength: 3) ?? [], [1, -2, 0.5])
        XCTAssertNil(SqliteVectors.decode(encoded, expectedLength: 5), "another dimension")
        XCTAssertNil(SqliteVectors.decodeBlob(Data([1, 2, 3])), "a partial blob")
        XCTAssertNil(SqliteVectors.decode("nope"))
        XCTAssertNil(SqliteVectors.decode(nil))

        let all = SqliteVectors.Capabilities(vec: true, udf: true, json1: true)
        XCTAssertEqual(
            SqliteVectors.plan(capabilities: all, declaredType: "BLOB", preference: nil),
            ["sqlite-vec", "udf"]
        )
        // A BLOB column has no JSON to read, so json_each could only produce NULLs.
        XCTAssertEqual(
            SqliteVectors.plan(
                capabilities: SqliteVectors.Capabilities(json1: true), declaredType: "BLOB",
                preference: nil
            ),
            []
        )
        XCTAssertEqual(
            SqliteVectors.plan(
                capabilities: SqliteVectors.Capabilities(json1: true), declaredType: "TEXT",
                preference: nil
            ),
            ["sql"]
        )
        XCTAssertEqual(
            SqliteVectors.plan(capabilities: all, declaredType: "BLOB", preference: "udf"), ["udf"]
        )
        XCTAssertEqual(
            SqliteVectors.plan(capabilities: all, declaredType: "BLOB", preference: "memory"), [],
            "memory is the caller's own path, not a query"
        )

        var bind: [SQLValue] = []
        let udf = SqliteVectors.rankingQuery(
            strategy: SqliteVectors.strategyUdf, metric: .cosine, table: "[documents]",
            column: "[embedding]", vector: [1, 0, 0], take: 5, tail: " WHERE [id] = ?",
            placeholder: "?", bind: &bind
        )
        XCTAssertNotNil(udf)
        XCTAssertEqual(udf?.contains("WHERE distance IS NOT NULL"), true)
        switch bind.first {
        case .some(.blob): break
        default: XCTFail("the query vector is bound as bytes")
        }
        bind = []
        let json = SqliteVectors.rankingQuery(
            strategy: SqliteVectors.strategySQL, metric: .cosine, table: "[documents]",
            column: "[embedding]", vector: [1, 0, 0], take: 5, tail: "", placeholder: "?", bind: &bind
        )
        XCTAssertEqual(json?.contains("json_each"), true)
        switch bind.first {
        case .some(.text): break
        default: XCTFail("json_each reads the vector as text")
        }
    }

    func testSqliteVectorSearchAndRoundTrip() throws {
        let adapter = try makeBlobAdapter()
        let documents = adapter.table("Document")
        let vectors: [(String, [Double])] = [
            ("d1", [1, 0, 0]), ("d2", [0.8, 0.2, 0]), ("d3", [0, 1, 0]),
        ]
        for (id, vector) in vectors {
            try adapter.execute(
                "INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)",
                [id, id, SqliteVectors.encode(vector)]
            )
        }
        // A row with another dimension must never rank against a 3-dimension query, and one
        // with no vector must not win by default.
        try adapter.execute(
            "INSERT INTO documents (id, title, embedding) VALUES ('d4', 'd4', ?)",
            [SqliteVectors.encode([1, 0, 0, 1])]
        )
        try adapter.execute("INSERT INTO documents (id, title, embedding) VALUES ('d5', 'd5', NULL)")

        for metric in [DistanceMetric.cosine, .euclidean, .dot] {
            let hits = try documents.vectorSearch([1, 0, 0], take: 9, metric: metric)
            XCTAssertEqual(hits.compactMap { $0["title"] as? String }, ["d1", "d2", "d3"],
                           "\(metric.rawValue) row order")
            XCTAssertNotNil(hits.first?["distance"] as Any?, "\(metric.rawValue) reports a distance")
            XCTAssertTrue(hits.first?["embedding"] is [Double], "\(metric.rawValue) decodes the column")
        }

        // `memory` pins the client-side fallback, which ranks the same rows.
        adapter.vectorStrategy = SqliteVectors.strategyMemory
        let pinned = try documents.vectorSearch([1, 0, 0], take: 9)
        XCTAssertEqual(pinned.compactMap { $0["title"] as? String }, ["d1", "d2", "d3"])
        adapter.vectorStrategy = nil

        let written = try documents.create(
            ["id": "d9", "title": "written", "embedding": [0.25, 0.5, 1.0]]
        )
        let stored = try adapter.query("SELECT typeof(embedding) AS t FROM documents WHERE id = 'd9'")
        XCTAssertEqual(stored.first?["t"] as? String, "blob", "an array is written as a float32 BLOB")
        XCTAssertEqual(written["embedding"] as? [Double] ?? [], [0.25, 0.5, 1.0])

        let found = try documents.findMany(filter: ["id": "d9"])
        XCTAssertEqual(found.first?["embedding"] as? [Double] ?? [], [0.25, 0.5, 1.0])
        try documents.update(filter: ["id": "d1"], data: ["embedding": [0.5, 0.5, 0]])
        let updated = try documents.findMany(filter: ["id": "d1"])
        XCTAssertEqual(updated.first?["embedding"] as? [Double] ?? [], [0.5, 0.5, 0])
        XCTAssertEqual(updated.first?["title"] as? String, "d1", "a non-vector column is untouched")
        try documents.updateMany(filter: ["id": "d2"], data: ["embedding": [0, 0, 1]])
        let many = try documents.findMany(filter: ["id": "d2"])
        XCTAssertEqual(many.first?["embedding"] as? [Double] ?? [], [0, 0, 1])
    }

    /// A database whose vector column holds float32 BLOBs, as `VECTOR(n)` now maps to.
    private func makeBlobAdapter() throws -> An5Adapter {
        let metadata = Metadata(
            modelToTable: ["Document": "documents"],
            modelFields: [
                "Document": [
                    FieldMeta(name: "id", type: "string", sqlType: "TEXT", isId: true),
                    FieldMeta(name: "title", type: "string", sqlType: "TEXT"),
                    FieldMeta(
                        name: "embedding", type: "number[] | string", sqlType: "VECTOR(3)",
                        isOptional: true
                    ),
                ]
            ],
            relationMap: [:]
        )
        let adapter = try An5Adapter(path: ":memory:", metadata: metadata)
        try adapter.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding BLOB)")
        return adapter
    }

    // MARK: - Metadata

    func testMetadataAcceptsEitherSpelling() throws {
        let snake = try XCTUnwrap(Metadata([
            "model_to_table": ["User": "users"],
            "model_fields": ["User": [["name": "id", "isId": true]]],
            "relation_map": [:],
        ]))
        XCTAssertEqual(snake.table("User"), "users")
        XCTAssertEqual(snake.idField("User")?.name, "id")

        let camel = try XCTUnwrap(Metadata([
            "modelToTable": ["user": "users"],
            "modelFields": ["user": [["name": "id", "isId": true]]],
            "relationMap": [:],
        ]))
        // The generated client names tables in PascalCase while the metadata keys them in
        // camelCase; a plain lookup would find no columns and skip the primary key.
        XCTAssertEqual(camel.table("User"), "users")
        XCTAssertEqual(camel.idField("User")?.name, "id")
    }

    func testUnsupportedValueIsRejectedNotSilentlyDropped() throws {
        struct Opaque {}
        let adapter = try makeAdapter()
        // A value with no encoding becomes NULL rather than being interpolated into the SQL.
        try adapter.table("User").create(["name": Opaque(), "score": 1])
        XCTAssertEqual(try adapter.table("User").count(), 1)
    }

    // MARK: - Fixtures

    static let metadata = Metadata(
        modelToTable: ["User": "users", "Post": "posts", "Document": "documents"],
        modelFields: [
            "User": [FieldMeta(name: "id", type: "string", sqlType: "NVARCHAR(255)", isId: true),
                     FieldMeta(name: "name", type: "string", sqlType: "NVARCHAR(255)"),
                     FieldMeta(name: "score", type: "number", sqlType: "INT")],
            "Post": [FieldMeta(name: "id", type: "string", sqlType: "NVARCHAR(255)", isId: true),
                     FieldMeta(name: "title", type: "string", sqlType: "NVARCHAR(255)"),
                     FieldMeta(name: "userId", type: "string", sqlType: "NVARCHAR(255)")],
            "Document": [FieldMeta(name: "id", type: "string", sqlType: "NVARCHAR(255)", isId: true),
                         FieldMeta(name: "title", type: "string", sqlType: "NVARCHAR(255)"),
                         FieldMeta(name: "embedding", type: "vector", sqlType: "VECTOR")],
        ],
        relationMap: [
            "User": [
                "posts": RelationDef(modelName: "Post", relationType: "many", foreignKey: "userId", localKey: "id")
            ]
        ]
    )
}