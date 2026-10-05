import Foundation

/// CRUD and queries for one table, driven entirely by the registered metadata.
///
/// Rows come back as `[String: Any?]`, so this client stays independent of the schema and of
/// the generator — the same reason the other adapters' table clients work on untyped rows.
/// The generated client wraps them in its own model types.
public struct TableClient {

    public let adapter: An5Adapter
    public let model: String

    private var dialect: Dialect { adapter.dialect }
    private var metadata: Metadata { adapter.metadata }

    public init(adapter: An5Adapter, model: String) {
        self.adapter = adapter
        self.model = model
    }

    private var tableSQL: String { SQLBuilder.quoteTable(metadata.table(model), dialect: dialect) }

    /// `WITH (NOLOCK)` is an MSSQL hint; leaving it in makes every other dialect fail.
    private var noLock: String { dialect.supportsNoLock ? " WITH (NOLOCK)" : "" }

    // ─── Reads ──────────────────────────────────────────────────────────────────

    /// Every row, unfiltered.
    public func findMany() throws -> [Row] {
        try findMany(Query())
    }

    /// The rows matching `query`.
    public func findMany(_ query: Query) throws -> [Row] {
        let clause = SQLBuilder.whereClause(query.filter, dialect: dialect)
        let orderBy = SQLBuilder.orderBy(query.orderBy, dialect: dialect)
        let relations = metadata.relations(model)
        let selected = query.select ?? []

        let columns: String
        if !selected.isEmpty && !hasRelationSelect(selected, relations) {
            columns = "SELECT " + selected.map { dialect.quote($0) }.joined(separator: ", ")
        } else {
            columns = "SELECT *"
        }

        var sql = "\(columns) FROM \(tableSQL)\(noLock)"
        if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
        if !orderBy.isEmpty { sql += " \(orderBy)" }
        sql += dialect.pagination(take: query.take, skip: query.skip, orderBy: orderBy)

        var rows = try adapter.query(sql, parameters(clause.parameters))
        if let include = query.include, !include.isEmpty {
            try resolveIncludes(relations, rows: &rows, include: include)
        }
        if let select = query.select {
            if hasRelationSelect(select, relations) {
                try resolveIncludes(relations, rows: &rows, include: relationSelect(select, relations))
            }
            rows = rows.map { project($0, selected: select) }
        }
        return rows
    }

    /// The rows matching `filter`, with the optional refinements `query` adds.
    public func findMany(filter: Where, _ query: Query = Query()) throws -> [Row] {
        var copy = query
        copy.filter = filter
        return try findMany(copy)
    }

    /// The first matching row, or `nil`. Always limited to one row server-side.
    public func findFirst(_ query: Query) throws -> Row? {
        try findMany(query.limited(to: 1)).first
    }

    public func findFirst(filter: Where) throws -> Row? {
        try findFirst(Query(filter: filter))
    }

    /// The row `filter` identifies, or `nil`.
    public func findUnique(filter: Where) throws -> Row? {
        try findFirst(Query(filter: filter))
    }

    /// How many rows match.
    public func count(_ filter: Where? = nil) throws -> Int {
        let clause = SQLBuilder.whereClause(filter, dialect: dialect)
        var sql = "SELECT COUNT(*) AS cnt FROM \(tableSQL)\(noLock)"
        if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
        let rows = try adapter.query(sql, parameters(clause.parameters))
        guard let first = rows.first, let value = first.values.first else { return 0 }
        return (value as? NSNumber)?.intValue ?? 0
    }

    // ─── Writes ─────────────────────────────────────────────────────────────────

    /// Inserts a row and returns it, re-read so server-side defaults come back with it.
    ///
    /// A model with an `@id` column and no value for it gets a generated identifier, which is
    /// what makes a client-created row addressable without a database-side default.
    @discardableResult
    public func create(_ data: Values, _ query: Query = Query()) throws -> Row {
        var scalars = data
        let relationWrites = splitRelationWrites(scalars)
        for key in relationWrites.keys { scalars.removeValue(forKey: key) }

        if let idField = metadata.idField(model) {
            let missing = scalars[idField.name].map { $0 == nil || $0 is NSNull } ?? true
            if missing { scalars[idField.name] = UUID().uuidString }
        }

        var columns: [String] = []
        var values: [SQLValue] = []
        for (column, value) in scalars {
            // A null column is left out rather than bound as NULL: an unset column takes the
            // schema's DEFAULT, which is what the caller meant by leaving it out.
            guard let value, !(value is NSNull) else { continue }
            columns.append(column)
            values.append(SQLValue.encode(value) ?? .null)
        }

        if !columns.isEmpty {
            let placeholders = columns.map { _ in dialect.placeholder }.joined(separator: ", ")
            let sql = "INSERT INTO \(tableSQL) (\(columns.map { dialect.quote($0) }.joined(separator: ", ")))"
                + " VALUES (\(placeholders))"
            try adapter.execute(sql, parameters(values))
        }

        var created = scalars
        if let idField = metadata.idField(model) {
            let found = try findFirst(filter: [idField.name: scalars[idField.name] as Any?])
            if let found { created = found }
        }

        try applyRelationCreates(created, relationWrites: relationWrites)
        // `created` is never nil here, so the projection cannot come back empty either.
        return try projectAfterWrite(created, query) ?? created
    }

    /// Inserts many rows, one statement each.
    ///
    /// Row-at-a-time on purpose: a batch would share one parameter list, so a single bad row
    /// would lose every good row with it, and `skipDuplicates` has no meaning for a batch.
    @discardableResult
    public func createMany(_ rows: [Values], skipDuplicates: Bool = false) throws -> Int {
        var count = 0
        for row in rows {
            do {
                try create(row)
                count += 1
            } catch {
                if !skipDuplicates { throw error }
            }
        }
        return count
    }

    /// Updates the matching rows and returns the first of them re-read.
    @discardableResult
    public func update(filter: Where, data: Values, query: Query = Query()) throws -> Row? {
        let clause = SQLBuilder.whereClause(filter, dialect: dialect, prefix: "w_")
        var scalars = data
        let relationWrites = splitRelationWrites(scalars)
        for key in relationWrites.keys { scalars.removeValue(forKey: key) }

        var setParts: [String] = []
        var setValues: [SQLValue] = []
        for (column, value) in scalars {
            guard let value, !(value is NSNull) else { continue }
            SQLBuilder.appendUpdateSet(&setParts, &setValues, column: column, value: value, dialect: dialect)
        }

        if !setParts.isEmpty {
            var sql = "UPDATE \(tableSQL) SET \(setParts.joined(separator: ", "))"
            if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
            try adapter.execute(sql, parameters(setValues + clause.parameters))
        }

        let updated = try findFirst(Query(filter: filter))
        try applyRelationUpdates(updated, filter: filter, relationWrites: relationWrites)
        return try projectAfterWrite(updated, query)
    }

    /// Updates every matching row and gives back how many changed.
    @discardableResult
    public func updateMany(filter: Where?, data: Values) throws -> Int {
        let clause = SQLBuilder.whereClause(filter, dialect: dialect, prefix: "w_")
        var setParts: [String] = []
        var setValues: [SQLValue] = []
        for (column, value) in data {
            guard let value, !(value is NSNull) else { continue }
            SQLBuilder.appendUpdateSet(&setParts, &setValues, column: column, value: value, dialect: dialect)
        }
        guard !setParts.isEmpty else { return 0 }

        var sql = "UPDATE \(tableSQL) SET \(setParts.joined(separator: ", "))"
        if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
        return try adapter.execute(sql, parameters(setValues + clause.parameters))
    }

    /// Deletes the matching rows and returns the one that was there first.
    @discardableResult
    public func delete(filter: Where) throws -> Row? {
        let existing = try findFirst(filter: filter)
        try deleteMany(filter: filter)
        return existing
    }

    /// Deletes every matching row, or the whole table when `filter` is `nil`.
    @discardableResult
    public func deleteMany(filter: Where? = nil) throws -> Int {
        let clause = SQLBuilder.whereClause(filter, dialect: dialect)
        var sql = "DELETE FROM \(tableSQL)"
        if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
        return try adapter.execute(sql, parameters(clause.parameters))
    }

    /// Updates the matching row when it exists, creates it otherwise.
    @discardableResult
    public func upsert(filter: Where, create: Values, update: Values) throws -> Row {
        if let existing = try findFirst(filter: filter) {
            return try self.update(filter: filter, data: update) ?? existing
        }
        return try self.create(create)
    }

    // ─── Aggregation ────────────────────────────────────────────────────────────

    /// One row of aggregate values, keyed `_count`, `_sum_<field>` and so on.
    public func aggregate(_ aggregate: Aggregate) throws -> Row {
        let expressions = selectExpressions(aggregate, includeCount: aggregate.count)
        guard !expressions.isEmpty else {
            throw An5Error.invalidQuery("aggregate requires at least one aggregator column")
        }
        let clause = SQLBuilder.whereClause(aggregate.filter, dialect: dialect)
        var sql = "SELECT \(expressions.joined(separator: ", ")) FROM \(tableSQL)"
        if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
        return try adapter.query(sql, parameters(clause.parameters)).first ?? [:]
    }

    /// One row per group, each carrying the group's `_count` and aggregates.
    public func groupBy(_ aggregate: Aggregate) throws -> [Row] {
        guard !aggregate.by.isEmpty else {
            throw An5Error.invalidQuery("groupBy requires at least one 'by' column")
        }
        let clause = SQLBuilder.whereClause(aggregate.filter, dialect: dialect)
        let byColumns = aggregate.by.map { dialect.quote($0) }.joined(separator: ", ")
        // Counted unconditionally: a group is only useful next to its size, and a group whose
        // rows were all filtered out still has to come back as a zero rather than disappear.
        var expressions = ["COUNT(*) AS _count"]
        expressions += selectExpressions(aggregate, includeCount: false)

        var sql = "SELECT \(byColumns), \(expressions.joined(separator: ", ")) FROM \(tableSQL)"
        if !clause.isEmpty { sql += " WHERE \(clause.sql)" }
        sql += " GROUP BY \(byColumns)"

        var orderBy = SQLBuilder.orderBy(aggregate.orderBy, dialect: dialect)
        let paging = aggregate.take != nil || aggregate.skip > 0
        if orderBy.isEmpty && paging {
            // Paging an unordered result gives an arbitrary slice of the groups; ordering by
            // the group columns at least makes the same query return the same slice.
            orderBy = "ORDER BY \(byColumns)"
        }
        if !orderBy.isEmpty { sql += " \(orderBy)" }
        if paging {
            sql += dialect.pagination(take: aggregate.take ?? 1, skip: aggregate.skip, orderBy: orderBy)
        }
        return try adapter.query(sql, parameters(clause.parameters))
    }

    private func selectExpressions(_ aggregate: Aggregate, includeCount: Bool) -> [String] {
        var expressions: [String] = []
        if includeCount { expressions.append("COUNT(*) AS _count") }
        for (function, fields) in [("SUM", aggregate.sum), ("AVG", aggregate.average), ("MIN", aggregate.minimum), ("MAX", aggregate.maximum)] {
            for field in fields {
                expressions.append("\(function)(\(dialect.quote(field))) AS _\(function.lowercased())_\(field)")
            }
        }
        return expressions
    }

    // ─── Vector search ──────────────────────────────────────────────────────────

    /// The rows nearest `vector`, by the database's own vector functions where it has them
    /// and in memory where it does not.
    ///
    /// SQLite has no vector operators at all, so it goes straight to the fallback rather than
    /// building SQL that will only throw.
    public func vectorSearch(
        _ vector: [Double],
        take: Int = 10,
        filter: Where? = nil,
        vectorField: String = "embedding",
        metric: DistanceMetric = .cosine
    ) throws -> [Row] {
        let field = vectorField.isEmpty ? "embedding" : vectorField
        let clause = SQLBuilder.whereClause(filter, dialect: dialect)
        let quotedField = dialect.quote(field)

        if dialect == .sqlite {
            return try vectorSearchInMemory(
                vector, take: take, filter: filter, field: field, metric: metric
            )
        }

        do {
            let sql: String
            let values: [SQLValue] = [.text(Vectors.format(vector))]
            if dialect == .postgres {
                let op = metric == .euclidean ? "<->" : (metric == .dot ? "<#>" : "<=>")
                sql = "SELECT *, (\(quotedField) \(op) \(dialect.placeholder)::vector) AS distance"
                    + " FROM \(tableSQL) WHERE \(quotedField) IS NOT NULL"
                    + (clause.isEmpty ? "" : " AND (\(clause.sql))")
                    + " ORDER BY distance ASC LIMIT \(take)"
            } else {
                let dimension = vector.count
                sql = "SELECT TOP (\(take)) *, VECTOR_DISTANCE('\(metric.rawValue)',"
                    + " CAST(\(quotedField) AS VECTOR(\(dimension), float32)),"
                    + " CAST(\(dialect.placeholder) AS VECTOR(\(dimension), float32))) AS distance"
                    + " FROM \(tableSQL)\(noLock)"
                    + " WHERE \(quotedField) IS NOT NULL"
                    + (clause.isEmpty ? "" : " AND (\(clause.sql))")
                    + " ORDER BY distance ASC"
            }
            return try adapter.query(sql, parameters(values + clause.parameters))
        } catch {
            // The engine may have no vector extension installed at all. Falling through to the
            // in-memory path is the documented behaviour, not a silent success.
            return try vectorSearchInMemory(vector, take: take, filter: filter, field: field, metric: metric)
        }
    }

    private func vectorSearchInMemory(
        _ vector: [Double],
        take: Int,
        filter: Where?,
        field: String,
        metric: DistanceMetric
    ) throws -> [Row] {
        let rows = try findMany(Query(filter: filter))
        var scored: [(row: Row, distance: Double)] = []
        for row in rows {
            guard let stored = Vectors.parse(cell(row, field), expectedLength: vector.count) else { continue }
            scored.append((row, DistanceMetric.distance(metric, vector, stored)))
        }
        scored.sort { $0.distance < $1.distance }
        return scored.prefix(take).map { entry -> Row in
            var row = entry.row
            row["distance"] = entry.distance
            return row
        }
    }

    // ─── Relations ──────────────────────────────────────────────────────────────

    /// Eager-loads relations onto rows already fetched.
    private func resolveIncludes(
        _ relations: [String: RelationDef],
        rows: inout [Row],
        include: Include
    ) throws {
        guard !rows.isEmpty, !include.isEmpty else { return }

        for (key, value) in include {
            if value == nil || (value is Bool && value as? Bool == false) { continue }

            if key == "_count" {
                try applyRelationCounts(relations, rows: &rows)
                continue
            }
            guard let relation = relations[key] else { continue }

            let isMany = relation.isMany
            let joinKey = isMany ? relation.localKey : relation.foreignKey
            let matchKey = isMany ? relation.foreignKey : relation.localKey

            let uniqueKeys = uniqueValues(rows, column: joinKey)
            guard !uniqueKeys.isEmpty else {
                for index in rows.indices { rows[index][key] = isMany ? [Row]() : nil }
                continue
            }

            let options = value as? [String: Any?] ?? [:]
            var nested = Query()
            var nestedFilter: Where = [matchKey: ["in": uniqueKeys]]
            if let extra = options["where"] as? Where {
                for (column, condition) in extra { nestedFilter[column] = condition }
            }
            nested.filter = nestedFilter
            nested.orderBy = SQLBuilder.orderEntries(cell(options, "orderBy"))
            if let skip = options["skip"] as? Int { nested.skip = max(0, skip) }
            if let take = options["take"] as? Int { nested.take = take }

            var related = try adapter.table(relation.modelName).findMany(nested)
            if let nestedInclude = options["include"] as? Include {
                try resolveIncludes(metadata.relations(relation.modelName), rows: &related, include: nestedInclude)
            }
            var projected = related
            if let nestedSelect = options["select"] as? [String] {
                projected = related.map { project($0, selected: nestedSelect) }
            }

            let groupColumn = isMany ? relation.foreignKey : relation.localKey
            var groups: [String: [Row]] = [:]
            for (index, row) in related.enumerated() {
                groups[groupKey(cell(row, groupColumn)), default: []].append(projected[index])
            }
            let rowColumn = isMany ? relation.localKey : relation.foreignKey
            for index in rows.indices {
                let matches = groups[groupKey(cell(rows[index], rowColumn))] ?? []
                rows[index][key] = isMany ? matches : matches.first
            }
        }
    }

    private func applyRelationCounts(_ relations: [String: RelationDef], rows: inout [Row]) throws {
        for index in rows.indices { rows[index]["_count"] = [String: Int]() }
        for (name, relation) in relations where relation.isMany {
            let uniqueKeys = uniqueValues(rows, column: relation.localKey)
            guard !uniqueKeys.isEmpty else {
                for index in rows.indices {
                    var totals = rows[index]["_count"] as? [String: Int] ?? [:]
                    totals[name] = 0
                    rows[index]["_count"] = totals
                }
                continue
            }
            let related = try adapter.table(relation.modelName)
                .findMany(filter: [relation.foreignKey: ["in": uniqueKeys]])
            var counts: [String: Int] = [:]
            for row in related {
                let key = groupKey(cell(row, relation.foreignKey))
                counts[key, default: 0] += 1
            }
            for index in rows.indices {
                let key = groupKey(cell(rows[index], relation.localKey))
                var totals = rows[index]["_count"] as? [String: Int] ?? [:]
                totals[name] = counts[key] ?? 0
                rows[index]["_count"] = totals
            }
        }
    }

    /// The relation objects in a write payload, keyed by relation name.
    private func splitRelationWrites(_ data: Values) -> [String: Any?] {
        let relations = metadata.relations(model)
        return data.filter { relations[$0.key] != nil && $0.value is [String: Any?] }
    }

    private func applyRelationCreates(_ parent: Row, relationWrites: [String: Any?]) throws {
        let relations = metadata.relations(model)
        for (key, value) in relationWrites {
            guard let relation = relations[key], let write = value as? [String: Any?] else { continue }
            guard let create = write["create"] else { continue }
            for item in asRows(create) {
                var merged = item
                merged[relation.foreignKey] = parent[relation.localKey]
                try adapter.table(relation.modelName).create(merged)
            }
        }
    }

    private func applyRelationUpdates(
        _ parent: Row?,
        filter: Where,
        relationWrites: [String: Any?]
    ) throws {
        let relations = metadata.relations(model)
        for (key, value) in relationWrites {
            guard let relation = relations[key], let write = value as? [String: Any?] else { continue }
            let child = adapter.table(relation.modelName)

            if let create = write["create"] {
                for item in asRows(create) {
                    var merged = item
                    merged[relation.foreignKey] = parent?[relation.localKey]
                    try child.create(merged)
                }
            }
            if let update = write["update"] as? [String: Any?] {
                let spec = update
                // Falls back to the parent's filter, never to "no filter": a relation update
                // with no filter of its own would otherwise rewrite every related row.
                let nestedFilter = (spec["where"] as? Where) ?? filter
                let nestedData = (spec["data"] as? Values) ?? [:]
                try child.update(filter: nestedFilter, data: nestedData)
            }
            if let disconnect = write["disconnect"] as? Where {
                try child.updateMany(filter: disconnect, data: [relation.foreignKey: NSNull()])
            }
        }
    }

    private func projectAfterWrite(_ row: Row?, _ query: Query) throws -> Row? {
        guard let row else { return nil }
        var rows = [row]
        let relations = metadata.relations(model)
        if let include = query.include, !include.isEmpty {
            try resolveIncludes(relations, rows: &rows, include: include)
        }
        if let select = query.select {
            try resolveIncludes(relations, rows: &rows, include: relationSelect(select, relations))
            return project(rows[0], selected: select)
        }
        return rows[0]
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /// Already-encoded values on their way to the adapter's untyped entry point.
    private func parameters(_ values: [SQLValue]) -> [Any?] {
        values.map { $0.unwrapped }
    }

    private func hasRelationSelect(_ selected: [String], _ relations: [String: RelationDef]) -> Bool {
        selected.contains { $0 == "_count" || relations[$0] != nil }
    }

    private func relationSelect(_ selected: [String], _ relations: [String: RelationDef]) -> Include {
        var include: Include = [:]
        for field in selected where field == "_count" || relations[field] != nil {
            include[field] = true
        }
        return include
    }

    private func project(_ row: Row, selected: [String]) -> Row {
        guard !selected.isEmpty else { return row }
        var projected: Row = [:]
        for field in selected where row.keys.contains(field) { projected[field] = row[field] }
        if let count = row["_count"] { projected["_count"] = count }
        return projected
    }

    private func uniqueValues(_ rows: [Row], column: String) -> [Any?] {
        var seen = Set<String>()
        var values: [Any?] = []
        for row in rows {
            guard let value = cell(row, column), !(value is NSNull) else { continue }
            // Numbers are normalised so a key read as an Int in one row and a Double in the
            // next does not become two `IN` values for the same row.
            let key: String
            if let number = value as? NSNumber { key = "\(number.doubleValue)" } else { key = text(value) }
            if seen.insert(key).inserted { values.append(value) }
        }
        return values
    }

    /// A cell's value, flattened.
    ///
    /// A `[String: Any?]` lookup yields `Any??` — an absent column and a `NULL` column are
    /// different things — and threading that double optional through every relation lookup
    /// is where a `NULL` foreign key quietly stops matching its rows.
    private func cell(_ row: Row, _ column: String) -> Any? {
        row[column] ?? nil
    }

    private func groupKey(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "\u{0}null" }
        if let number = value as? NSNumber { return "\(number.doubleValue)" }
        return text(value)
    }

    /// A value rendered as text for a join key, with no optional's debug decoration.
    private func text(_ value: Any) -> String {
        if let text = value as? String { return text }
        if let uuid = value as? UUID { return uuid.uuidString }
        if let data = value as? Foundation.Data { return data.base64EncodedString() }
        return String(describing: value)
    }

    private func asRows(_ value: Any?) -> [Values] {
        if let rows = value as? [Values] { return rows }
        if let row = value as? Values { return [row] }
        return []
    }
}