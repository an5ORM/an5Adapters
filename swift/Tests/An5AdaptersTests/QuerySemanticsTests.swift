import Foundation
import XCTest
@testable import An5Adapters

/// Runs the shared query contract in `test/fixtures/query-semantics.json` through the Swift
/// SQL builder and a real SQLite database.
///
/// The same fixture gates the TypeScript, Python, Go and Java builders, which is the point: a
/// where tree that means one thing in one client and another in the next is a bug in the
/// client, and only a shared fixture catches it.
final class QuerySemanticsTests: XCTestCase {

    private static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // An5AdaptersTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // swift
        .deletingLastPathComponent()   // an5Adapters
        .appendingPathComponent("test/fixtures/query-semantics.json")

    func testSharedContract() throws {
        let data = try Data(contentsOf: Self.fixtureURL)
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(fixture["rows"] as? [[String: Any]])
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]])

        let driver = try SQLiteDriver(path: ":memory:")
        let adapter = An5Adapter(driver: driver, connectionString: "sqlite::memory:")
        try adapter.execute(
            "CREATE TABLE users (id INTEGER, score INTEGER)"
        )
        for row in rows {
            try adapter.execute(
                "INSERT INTO users VALUES (?, ?)",
                [row["id"] as Any, row["score"] as Any]
            )
        }

        for testCase in cases {
            let name = testCase["name"] as? String ?? "<unnamed>"
            let filter = testCase["where"] as? [String: Any?] ?? [:]
            let expected = (testCase["ids"] as? [Int]) ?? []

            let clause = SQLBuilder.whereClause(filter, dialect: .sqlite)
            let sql = "SELECT id FROM users" + (clause.isEmpty ? "" : " WHERE \(clause.sql)") + " ORDER BY id"
            let found = try adapter.query(sql, clause.parameters.map { $0 as Any? })
            let actual = found.compactMap { ($0["id"] as? NSNumber)?.intValue }

            XCTAssertEqual(actual, expected, name)
        }
    }
}