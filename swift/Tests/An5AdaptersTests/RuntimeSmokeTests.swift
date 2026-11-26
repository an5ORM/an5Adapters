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
        XCTAssertEqual(Dialect.sqlite.pagination(take: nil, skip: 5, orderBy: ""), " LIMIT -1 OFFSET 5")
        XCTAssertEqual(Dialect.postgres.pagination(take: nil, skip: 5, orderBy: ""), " LIMIT ALL OFFSET 5")
        XCTAssertEqual(Dialect.mssql.pagination(take: nil, skip: 5, orderBy: ""), " ORDER BY (SELECT NULL) OFFSET 5 ROWS")
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

    /// A loaded AN5 C extension must not be shadowed by the Swift callbacks.
///
/// SQLite lets a later `sqlite3_create_function` replace an earlier one, so registering
/// callbacks over a loaded extension would silently swap native code for the slower path.
///
/// Skipped unless `AN5_NATIVE_VECTOR_PATH` points at a built extension; the Swift gate
/// builds one with `build:sqlite:native`, like the Python and .NET gates do.
    func testNativeExtensionIsPreserved() throws {
        guard let path = ProcessInfo.processInfo.environment["AN5_NATIVE_VECTOR_PATH"],
              FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("AN5_NATIVE_VECTOR_PATH is not set; run build:sqlite:native first")
        }
        SQLiteDriver.sqliteVecPath = path
        defer { SQLiteDriver.sqliteVecPath = nil }
        let driver = try SQLiteDriver(path: ":memory:")

        let loaded = try driver.query("SELECT an5_vector_version() AS v", [])
        XCTAssertEqual(loaded.first?["v"] as? String, "an5-vector/1")

        // `0.1` is not representable in float32, so this result proves the C function is
        // in use: a Swift callback would compute it in Double.
        let rows = try driver.query("SELECT an5_vec_ip('[0.1]', '[0.1]') AS d", [])
        let expected = -(Double(Float(0.1)) * Double(Float(0.1)))
        XCTAssertEqual(try XCTUnwrap(rows.first?["d"] as? Double), expected, accuracy: 1e-12)
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

    // MARK: - Relation filters & strict validation

    private func makeRelationalAdapter() throws -> An5Adapter {
        let relationalMetadata = Metadata(
            modelToTable: ["User": "users", "Post": "posts", "Profile": "profiles"],
            modelFields: [
                "User": [
                    FieldMeta(name: "id", type: "string", sqlType: "TEXT", isId: true),
                    FieldMeta(name: "name", type: "string", sqlType: "TEXT"),
                    FieldMeta(name: "score", type: "number", sqlType: "INTEGER"),
                ],
                "Post": [
                    FieldMeta(name: "id", type: "string", sqlType: "TEXT", isId: true),
                    FieldMeta(name: "title", type: "string", sqlType: "TEXT"),
                    FieldMeta(name: "published", type: "boolean", sqlType: "INTEGER"),
                    FieldMeta(name: "authorId", type: "string", sqlType: "TEXT", isOptional: true),
                ],
                "Profile": [
                    FieldMeta(name: "id", type: "string", sqlType: "TEXT", isId: true),
                    FieldMeta(name: "bio", type: "string", sqlType: "TEXT"),
                    FieldMeta(name: "userId", type: "string", sqlType: "TEXT"),
                ],
            ],
            relationMap: [
                "User": [
                    "posts": RelationDef(modelName: "Post", relationType: "many", foreignKey: "authorId", localKey: "id"),
                    "profile": RelationDef(modelName: "Profile", relationType: "one", foreignKey: "userId", localKey: "id"),
                ],
                "Post": [
                    "author": RelationDef(modelName: "User", relationType: "one", foreignKey: "authorId", localKey: "id"),
                ],
                "Profile": [
                    "user": RelationDef(modelName: "User", relationType: "one", foreignKey: "userId", localKey: "id"),
                ],
            ]
        )
        let adapter = try An5Adapter(path: ":memory:", metadata: relationalMetadata)
        try adapter.execute("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, score INTEGER)")
        try adapter.execute("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, published INTEGER, authorId TEXT)")
        try adapter.execute("CREATE TABLE profiles (id TEXT PRIMARY KEY, bio TEXT, userId TEXT)")

        let users = adapter.table("User")
        let posts = adapter.table("Post")
        let profiles = adapter.table("Profile")

        try users.create(["id": "u1", "name": "Alice", "score": 100])
        try users.create(["id": "u2", "name": "Bob", "score": 50])
        try users.create(["id": "u3", "name": "Charlie", "score": 10])

        try profiles.create(["id": "pr1", "bio": "Systems engineer", "userId": "u1"])
        try profiles.create(["id": "pr2", "bio": "Draft writer", "userId": "u2"])

        try posts.create(["id": "p1", "title": "Published One", "published": true, "authorId": "u1"])
        try posts.create(["id": "p2", "title": "Draft One", "published": false, "authorId": "u1"])
        try posts.create(["id": "p3", "title": "All Published", "published": true, "authorId": "u2"])
        try posts.create(["id": "p4", "title": "Orphan Post", "published": true, "authorId": NSNull()])

        return adapter
    }

    func testRelationFiltersAndIncludes() throws {
        let adapter = try makeRelationalAdapter()
        let users = adapter.table("User")
        let posts = adapter.table("Post")

        func names(_ rows: [Row]) -> [String] {
            rows.compactMap { $0["name"] as? String }.sorted()
        }
        func titles(_ rows: [Row]) -> [String] {
            rows.compactMap { $0["title"] as? String }.sorted()
        }

        // To-many: some / none / every
        XCTAssertEqual(names(try users.findMany(filter: Query.some("posts", ["published": true]))), ["Alice", "Bob"])
        XCTAssertEqual(names(try users.findMany(filter: Query.some("posts"))), ["Alice", "Bob"])
        XCTAssertEqual(names(try users.findMany(filter: Query.some("posts", ["title": ["not": ["contains": "Published"]]]))), ["Alice"])
        XCTAssertEqual(names(try users.findMany(filter: Query.none("posts", ["published": false]))), ["Bob", "Charlie"])
        XCTAssertEqual(names(try users.findMany(filter: Query.none("posts"))), ["Charlie"])
        // Vacuous truth for `every`: Bob (all published) + Charlie (no posts)
        XCTAssertEqual(names(try users.findMany(filter: Query.every("posts", ["published": true]))), ["Bob", "Charlie"])
        XCTAssertEqual(names(try users.findMany(filter: Query.every("posts", [:]))), ["Alice", "Bob", "Charlie"])
        // Combined operators on the same relation key (distinct subquery aliases)
        XCTAssertEqual(
            names(try users.findMany(filter: ["posts": ["some": ["published": true], "none": ["published": false]]])),
            ["Bob"]
        )

        // To-one (FK on querying side: Post.author)
        XCTAssertEqual(
            titles(try posts.findMany(filter: Query.`is`("author", ["name": "Alice"]))),
            ["Draft One", "Published One"]
        )
        XCTAssertEqual(titles(try posts.findMany(filter: Query.`is`("author", nil))), ["Orphan Post"])
        XCTAssertEqual(
            titles(try posts.findMany(filter: Query.isNot("author", ["name": "Alice"]))),
            ["All Published", "Orphan Post"]
        )
        XCTAssertEqual(
            titles(try posts.findMany(filter: ["author": ["is_not": NSNull()]])),
            ["All Published", "Draft One", "Published One"]
        )

        // Inverse one-to-one (FK on related table: User.profile)
        XCTAssertEqual(names(try users.findMany(filter: Query.`is`("profile", ["bio": ["contains": "Systems"]]))), ["Alice"])
        XCTAssertEqual(names(try users.findMany(filter: Query.`is`("profile", nil))), ["Charlie"])
        XCTAssertEqual(names(try users.findMany(filter: Query.isNot("profile", nil))), ["Alice", "Bob"])

        // Multi-level nested relation filter: User -> posts.some -> author.is
        XCTAssertEqual(
            names(try users.findMany(filter: [
                "posts": [
                    "some": [
                        "author": [
                            "is": ["score": ["gte": 100]],
                        ],
                    ],
                ],
            ])),
            ["Alice"]
        )

        // Include on to-one FK-holding side and inverse 1-to-1 side
        let postWithAuthor = try posts.findMany(Query(filter: ["id": "p1"], include: ["author": true]))
        XCTAssertEqual((postWithAuthor.first?["author"] as? Row)?["name"] as? String, "Alice")
        let userWithProfile = try users.findMany(Query(filter: ["id": "u1"], include: ["profile": true]))
        XCTAssertEqual((userWithProfile.first?["profile"] as? Row)?["bio"] as? String, "Systems engineer")

        // Count & updateMany & deleteMany with relation filters
        XCTAssertEqual(try users.count(Query.some("posts", ["published": false])), 1)
        XCTAssertEqual(try posts.updateMany(filter: Query.`is`("author", ["name": "Bob"]), data: ["title": "Updated Bob Post"]), 1)
        XCTAssertEqual(try posts.findMany(filter: ["id": "p3"]).first?["title"] as? String, "Updated Bob Post")
        XCTAssertEqual(try posts.deleteMany(filter: Query.`is`("author", nil)), 1)
        XCTAssertEqual(try posts.count(), 3)

        // Multi-dialect SQL generation check
        let mssqlClause = try SQLBuilder.buildWhere(
            ["posts": ["some": ["published": true]]],
            dialect: .mssql,
            model: "User",
            metadata: adapter.metadata
        )
        XCTAssertTrue(mssqlClause.sql.contains("EXISTS (SELECT 1 FROM [posts] AS r_posts_some_ WHERE r_posts_some_.[authorId] = [users].[id]"))
        let pgClause = try SQLBuilder.buildWhere(
            ["author": ["is": ["score": ["gte": 50]]]],
            dialect: .postgres,
            model: "Post",
            metadata: adapter.metadata
        )
        XCTAssertTrue(pgClause.sql.contains("EXISTS (SELECT 1 FROM \"users\" AS r_author_is_ WHERE r_author_is_.\"id\" = \"posts\".\"authorId\""))
    }

    func testStrictFilterValidation() throws {
        let adapter = try makeRelationalAdapter()
        let users = adapter.table("User")
        let posts = adapter.table("Post")

        func assertInvalidQuery(_ filter: Where, client: TableClient, _ message: String) {
            XCTAssertThrowsError(try client.findMany(filter: filter), message) { error in
                guard case .invalidQuery = error as? An5Error else {
                    return XCTFail("expected An5Error.invalidQuery for \(message), got \(error)")
                }
            }
        }

        assertInvalidQuery(["name": ["bogus": "Ada"]], client: users, "unknown scalar operator")
        assertInvalidQuery(["ghosts": ["some": ["title": "x"]]], client: users, "unregistered relation")
        assertInvalidQuery(["posts": ["is": ["title": "x"]]], client: users, "to-one operator on to-many relation")
        assertInvalidQuery(["author": ["some": ["name": "Alice"]]], client: posts, "to-many operator on to-one relation")
        assertInvalidQuery(["posts": ["bogus": ["title": "x"]]], client: users, "unknown relation operator")
        assertInvalidQuery(["posts": "not-a-dict"], client: users, "non-dictionary relation filter")
        assertInvalidQuery(["posts": ["some": "not-a-dict"]], client: users, "non-dictionary some body")
        assertInvalidQuery(["author": ["is": 123]], client: posts, "non-dictionary is body")
        assertInvalidQuery(["OR": "invalid"], client: users, "non-array OR filter")
        assertInvalidQuery(["score": ["in": "not-an-array"]], client: users, "non-array in operand")
    }

    func testInsensitiveGroupByHavingAndStrictValidation() throws {
        let grpMeta = Metadata(
            modelToTable: ["GrpOrder": "grp_orders"],
            modelFields: [
                "GrpOrder": [
                    FieldMeta(name: "id", type: "string", sqlType: "TEXT", isId: true),
                    FieldMeta(name: "status", type: "string", sqlType: "TEXT"),
                    FieldMeta(name: "total", type: "number", sqlType: "INTEGER"),
                    FieldMeta(name: "note", type: "string", sqlType: "TEXT", isOptional: true),
                ]
            ],
            relationMap: [:]
        )
        let adapter = try An5Adapter(path: ":memory:", metadata: grpMeta)
        try adapter.execute("CREATE TABLE grp_orders (id TEXT PRIMARY KEY, status TEXT, total INTEGER, note TEXT)")
        let grp = adapter.table("GrpOrder")
        try grp.create(["id": "1", "status": "paid", "total": 150, "note": "vip"])
        try grp.create(["id": "2", "status": "paid", "total": 50, "note": NSNull()])
        try grp.create(["id": "3", "status": "open", "total": 120, "note": "hold"])
        try grp.create(["id": "4", "status": "cancelled", "total": 40, "note": NSNull()])

        XCTAssertEqual(try grp.findMany(filter: Query.equals("status", "OPEN", mode: "insensitive")).count, 1)
        XCTAssertEqual(try grp.findMany(filter: Query.not("status", "PAID", mode: "insensitive")).count, 2)
        XCTAssertEqual(
            try grp.findMany(filter: ["status": ["mode": "insensitive", "not": ["contains": "CANCEL"]]]).count,
            3
        )
        XCTAssertEqual(try grp.findMany(filter: Query.startsWith("status", "PA", mode: "insensitive")).count, 2)
        XCTAssertEqual(try grp.findMany(filter: Query.endsWith("status", "EN", mode: "insensitive")).count, 1)
        XCTAssertEqual(try grp.findMany(filter: Query.`in`("status", ["PAID", "OPEN"], mode: "insensitive")).count, 3)
        XCTAssertEqual(try grp.findMany(filter: Query.notIn("status", ["PAID"], mode: "insensitive")).count, 2)

        let pgInsensitive = try SQLBuilder.buildWhere(
            ["status": ["contains": "paid", "mode": "insensitive"]],
            dialect: .postgres,
            model: "GrpOrder",
            metadata: grpMeta
        )
        XCTAssertTrue(pgInsensitive.sql.contains("ILIKE"))

        var aggSpec = Aggregate()
        aggSpec.countFields = ["_all", "note"]
        aggSpec.sum = ["total"]
        aggSpec.average = ["total"]
        aggSpec.minimum = ["status", "total"]
        aggSpec.maximum = ["status", "total"]
        let agg = try grp.aggregate(aggSpec)
        XCTAssertEqual((agg["_count"] as? NSNumber)?.intValue, 4)
        XCTAssertEqual((agg["_count_note"] as? NSNumber)?.intValue, 2)
        XCTAssertEqual(agg["_min_status"] as? String, "cancelled")
        XCTAssertEqual(agg["_max_status"] as? String, "paid")

        var grpSpec = Aggregate()
        grpSpec.by = ["status"]
        grpSpec.countFields = ["_all", "note"]
        grpSpec.sum = ["total"]
        grpSpec.average = ["total"]
        grpSpec.minimum = ["total"]
        grpSpec.maximum = ["total"]
        grpSpec.having = [
            "OR": [
                ["_count": ["_all": ["gte": 2]]],
                ["_sum": ["total": ["gte": 120]]],
            ],
            "NOT": ["status": "cancelled"],
        ]
        grpSpec.orderBy = [["status": "asc"]]
        let grouped = try grp.groupBy(grpSpec)
        XCTAssertEqual(grouped.compactMap { $0["status"] as? String }, ["open", "paid"])
        XCTAssertEqual((grouped[1]["_count"] as? NSNumber)?.intValue, 2)
        XCTAssertEqual((grouped[1]["_count_note"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual((grouped[1]["_sum_total"] as? NSNumber)?.doubleValue, 200.0)
        XCTAssertEqual((grouped[1]["_avg_total"] as? NSNumber)?.doubleValue, 100.0)
        XCTAssertEqual((grouped[1]["_min_total"] as? NSNumber)?.intValue, 50)
        XCTAssertEqual((grouped[1]["_max_total"] as? NSNumber)?.intValue, 150)

        // WHERE + HAVING placeholder ordering and grouped scalar filter
        var combinedSpec = Aggregate()
        combinedSpec.by = ["status"]
        combinedSpec.filter = ["total": ["gte": 50]]
        combinedSpec.having = [
            "status": ["in": ["PAID"], "mode": "insensitive"],
            "_sum": ["total": ["gte": 200]],
        ]
        let scoped = try grp.groupBy(combinedSpec)
        XCTAssertEqual(scoped.compactMap { $0["status"] as? String }, ["paid"])

        // Offset-only pagination (SQLite LIMIT -1 OFFSET 1)
        var offsetSpec = Aggregate()
        offsetSpec.by = ["status"]
        offsetSpec.orderBy = [["status": "asc"]]
        offsetSpec.skip = 1
        let skipped = try grp.groupBy(offsetSpec)
        XCTAssertEqual(skipped.compactMap { $0["status"] as? String }, ["open", "paid"])

        // Strict rejections
        XCTAssertThrowsError(try grp.findMany(filter: ["status": ["equals": "paid", "mode": "fuzzy"]]))
        XCTAssertThrowsError(try grp.findMany(filter: ["bogus": "paid"]))
        XCTAssertThrowsError(try grp.findMany(filter: ["status": ["paid"]]))
        XCTAssertThrowsError(try grp.findMany(filter: ["status": ["equals": ["paid"]]]))
        XCTAssertThrowsError(try grp.findMany(filter: ["status": ["not": ["paid"]]]))
        XCTAssertThrowsError(try grp.findMany(filter: ["total": ["gt": [10]]]))
        XCTAssertThrowsError(try grp.findMany(filter: ["status": ["contains": 42]]))

        var badHavingScalar = Aggregate()
        badHavingScalar.by = ["status"]
        badHavingScalar.having = ["total": ["gte": 100]]
        XCTAssertThrowsError(try grp.groupBy(badHavingScalar))

        var badAllSum = Aggregate()
        badAllSum.by = ["status"]
        badAllSum.having = ["_sum": ["_all": 1]]
        XCTAssertThrowsError(try grp.groupBy(badAllSum))

        var badHavingField = Aggregate()
        badHavingField.by = ["status"]
        badHavingField.having = ["_count": ["bogus": 1]]
        XCTAssertThrowsError(try grp.groupBy(badHavingField))

        var badHavingOr = Aggregate()
        badHavingOr.by = ["status"]
        badHavingOr.having = ["OR": ["status": "paid"]]
        XCTAssertThrowsError(try grp.groupBy(badHavingOr))

        var badCountField = Aggregate()
        badCountField.by = ["status"]
        badCountField.countFields = ["bogus"]
        XCTAssertThrowsError(try grp.groupBy(badCountField))
    }

    // MARK: - Fixtures

    static let metadata = Metadata(
        modelToTable: ["User": "users", "Post": "posts", "Document": "documents"],
        modelFields: [
            "User": [FieldMeta(name: "id", type: "string", sqlType: "NVARCHAR(255)", isId: true),
                     FieldMeta(name: "name", type: "string", sqlType: "NVARCHAR(255)"),
                     FieldMeta(name: "score", type: "number", sqlType: "INT"),
                     FieldMeta(name: "nickname", type: "string", sqlType: "NVARCHAR(255)", isOptional: true)],
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