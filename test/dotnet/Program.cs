using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using An5Orm;

// SQLite smoke test for the .NET adapter.
//
// Run through scripts/dotnet-sqlite-smoke.js: the npm package ships only the raw
// .cs files, so the test builds a temporary project from exactly those files — the
// same source the compile-check uses, not a copy.
//
// The NameVi values are deliberately non-ASCII so the round trip through SQLite is
// exercised, not just ASCII text. an5:allow-non-english-file

public class CatalogType
{
    public string Id { get; set; }
    public string Key { get; set; }
    public string NameVi { get; set; }
}

public class RelUser
{
    public int Id { get; set; }
    public string Email { get; set; }
    public string Created_At { get; set; }
    public Dictionary<string, object> Profile { get; set; }
    public List<Dictionary<string, object>> Orders { get; set; }
    public Dictionary<string, object> _count { get; set; }
}

public class RelOrder
{
    public int Id { get; set; }
    public int User_Id { get; set; }
    public int Total { get; set; }
    public string Status { get; set; }
}

public class GrpOrder
{
    public int Id { get; set; }
    public string Status { get; set; }
    public int Total { get; set; }
    public string Note { get; set; }
}

internal static class Program
{
    private static int _failed;
    private static string _dbPath;

    private static void Check(string label, object got, object want)
    {
        var ok = Equals(got?.ToString(), want?.ToString());
        Console.WriteLine($"  {(ok ? "ok  " : "FAIL")} {label} = {got}");
        if (!ok)
        {
            Console.WriteLine($"       expected: {want}");
            _failed++;
        }
    }

    private static void CheckThrows<T>(string label, Action action) where T : Exception
    {
        try
        {
            action();
            Console.WriteLine($"  FAIL {label}: no exception");
            _failed++;
        }
        catch (T)
        {
            Console.WriteLine($"  ok   {label}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  FAIL {label}: {ex.GetType().Name}");
            _failed++;
        }
    }

    private static void DialectDetection()
    {
        Console.WriteLine("\n[dialect detection]");
        Check("sqlite://app.db", DialectDetector.Detect("sqlite://app.db"), Dialect.Sqlite);
        Check("sqlite:app.db", DialectDetector.Detect("sqlite:app.db"), Dialect.Sqlite);
        Check("Data Source=app.db", DialectDetector.Detect("Data Source=app.db"), Dialect.Sqlite);
        Check("app.db", DialectDetector.Detect("app.db"), Dialect.Sqlite);
        Check(":memory:", DialectDetector.Detect(":memory:"), Dialect.Sqlite);
        Check("postgres://u:p@h/db", DialectDetector.Detect("postgres://u:p@h/db"), Dialect.Postgres);
        Check("Host=h;Database=d", DialectDetector.Detect("Host=h;Database=d"), Dialect.Postgres);
        Check("Server=s;Database=d", DialectDetector.Detect("Server=s;Database=d"), Dialect.Mssql);
    }

    private static void Normalisation()
    {
        Console.WriteLine("\n[connection string]");
        Check("bare path", SqliteConnectionString.Normalize("app.db"), "Data Source=app.db");
        Check("sqlite:// prefix", SqliteConnectionString.Normalize("sqlite://app.db"), "Data Source=app.db");
        Check("sqlite: prefix", SqliteConnectionString.Normalize("sqlite:app.db"), "Data Source=app.db");
        Check("empty", SqliteConnectionString.Normalize(""), "Data Source=:memory:");
        Check(
            "already a data source",
            SqliteConnectionString.Normalize("Data Source=x.db;Cache=Shared"),
            "Data Source=x.db;Cache=Shared"
        );
    }

    private static void Quoting()
    {
        Console.WriteLine("\n[quoting]");
        Check("sqlite column", SqlQuote.QuoteName("NameVi", Dialect.Sqlite), "\"NameVi\"");
        Check("sqlite embedded quote", SqlQuote.QuoteName("a\"b", Dialect.Sqlite), "\"a\"\"b\"");
        Check("mssql unchanged", SqlQuote.QuoteName("NameVi", Dialect.Mssql), "[NameVi]");
    }

    private static void Crud(An5Adapter adapter)
    {
        var table = adapter.Table<CatalogType>("CatalogType");

        Check("dialect", adapter.Dialect, Dialect.Sqlite);

        adapter.ExecuteRaw(
            "CREATE TABLE \"CatalogType\" (\"Id\" TEXT PRIMARY KEY, \"Key\" TEXT NOT NULL UNIQUE, \"NameVi\" TEXT NOT NULL)");

        table.Create(new CatalogType { Id = "t1", Key = "XF", NameVi = "Xuân phát" });
        table.Create(new CatalogType { Id = "t2", Key = "ACE", NameVi = "Anh chính" });
        table.Create(new CatalogType { Id = "t3", Key = "DNT", NameVi = "Dịch vụ" });
        Console.WriteLine("  ok   DDL + insert");

        var ordered = table.FindMany(orderBy: "\"Key\" ASC");
        Check("order_by asc", string.Join(",", ordered.Select(r => r.Key)), "ACE,DNT,XF");
        Check("take", table.FindMany(take: 2).Count, 2);
        Check("skip", string.Join(",", table.FindMany(orderBy: "\"Key\" ASC", skip: 1, take: 1).Select(r => r.Key)), "DNT");
        Check("skip only", table.FindMany(skip: 2).Count, 1);
        Check("count", table.Count(), 3);
        Check("count where", table.Count(new CountArgs { Where = new Dictionary<string, object> { { "Key", "XF" } } }), 1);
        Check("where equals", table.FindFirst(new FindManyArgs { Where = new Dictionary<string, object> { { "Key", "ACE" } } })?.NameVi, "Anh chính");
        Check("where contains", table.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "Key", new Dictionary<string, object> { { "contains", "N" } } } } }).Count, 1);
        Check("find_unique", table.FindUnique("t2", "Id")?.Key, "ACE");
        Check(
            "in filter",
            table.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "Key", new Dictionary<string, object> { { "in", new List<object> { "XF", "ACE" } } } } } }).Count,
            2
        );

        table.Update(new CatalogType { Id = "t3", Key = "DNT", NameVi = "Dịch vụ (đã sửa)" });
        Check("update", table.FindUnique("t3", "Id")?.NameVi, "Dịch vụ (đã sửa)");

        Check(
            "delete_many",
            table.DeleteMany("\"Key\" = @key", new Dictionary<string, object> { { "key", "DNT" } }),
            1
        );
        Check("count after delete", table.Count(), 2);
    }

    private static void Transactions(An5Adapter adapter)
    {
        Console.WriteLine("\n[transaction]");
        var table = adapter.Table<CatalogType>("CatalogType");

        adapter.Transaction<int>(tx =>
        {
            table.Create(new CatalogType { Id = "t9", Key = "ZZZ", NameVi = "Trong giao dịch" });
            return 0;
        });
        Check("commit", table.FindUnique("t9", "Id")?.Key, "ZZZ");

        try
        {
            adapter.Transaction<int>(tx =>
            {
                table.Create(new CatalogType { Id = "t10", Key = "YYY", NameVi = "Sẽ rollback" });
                throw new InvalidOperationException("boom");
            });
            Console.WriteLine("  FAIL rollback: no exception surfaced");
            _failed++;
        }
        catch (InvalidOperationException)
        {
            Console.WriteLine("  ok   rollback path threw");
        }
        Check("rollback took effect", table.FindUnique("t10", "Id"), null);
    }

    private static void StoredProcedures(An5Adapter adapter)
    {
        Console.WriteLine("\n[stored procedures]");
        CheckThrows<NotSupportedException>("query_proc", () => adapter.QueryProc<CatalogType>("sp_who"));
        CheckThrows<NotSupportedException>("execute_proc", () => adapter.ExecuteProc("sp_who"));
    }

    private static void VectorSearch(An5Adapter adapter)
    {
        Console.WriteLine("\n[vector search -> a TEXT column, ranked by the driver function]");
        adapter.ExecuteRaw("CREATE TABLE \"Doc\" (\"Id\" TEXT PRIMARY KEY, \"Embedding\" TEXT)");
        adapter.ExecuteRaw(
            "INSERT INTO \"Doc\" VALUES ('d1', '[1.0, 0.0]'), ('d2', '[0.0, 1.0]'), ('d3', '[0.9, 0.1]')");

        var docs = adapter.Table<Doc>("Doc");
        var hits = docs.VectorSearch(new List<double> { 1.0, 0.0 }, take: 2, vectorField: "Embedding");
        Check("hit count", hits.Count, 2);
        Check("closest first", hits[0].Item.Id, "d1");
        Check("distance ordered", hits[0].Distance <= hits[1].Distance, true);
    }

    // A `VECTOR(n)` column stores a float32 BLOB. These cases cover the codec, the
    // strategy each column type selects, and the fallback when the connection
    // offers no in-database strategy at all. The module docstring in
    // Sqlite/SqliteVectors.cs is the shared specification for every runtime.
    private static void SqliteVectorSearch()
    {
        Console.WriteLine("\n[sqlite vector codec]");
        var encoded = SqliteVectors.EncodeVector(new List<double> { 1.0, -2.0, 0.5 });
        Check("float32 blob length", encoded.Length, 12);
        Check("little-endian 1.0", encoded[0] + "," + encoded[1] + "," + encoded[2] + "," + encoded[3], "0,0,128,63");
        var decoded = SqliteVectors.DecodeVector(encoded);
        Check("blob round trip", string.Join(",", decoded), "1,-2,0.5");
        Check("legacy JSON text", string.Join(",", SqliteVectors.DecodeVector("[1, 0, 0]")), "1,0,0");
        Check("already a list", SqliteVectors.DecodeVector(new List<double> { 1, 2 }).Count, 2);
        Check("already a float array", SqliteVectors.DecodeVector(new float[] { 1, 2, 3 })[2], 3.0);
        Check("read-only memory float", SqliteVectors.DecodeVector(new ReadOnlyMemory<float>(new float[] { 1, 2, 3 }))[2], 3.0);
        Check("read-only memory double", SqliteVectors.DecodeVector(new ReadOnlyMemory<double>(new double[] { 1, 2, 3 }))[2], 3.0);
        Check("rejects a partial blob", SqliteVectors.DecodeVector(new byte[3]) == null, true);
        Check("rejects text that is not JSON", SqliteVectors.DecodeVector("nope") == null, true);
        Check("cosine of a vector with itself", Math.Round(SqliteVectors.VectorDistance(new List<double> { 1, 0 }, new List<double> { 1, 0 }, "cosine").Value, 9), 0.0);
        Check("cosine of orthogonal vectors", Math.Round(SqliteVectors.VectorDistance(new List<double> { 1, 0 }, new List<double> { 0, 1 }, "cosine").Value, 9), 1.0);
        Check("euclidean distance", Math.Round(SqliteVectors.VectorDistance(new List<double> { 0, 3 }, new List<double> { 4, 0 }, "euclidean").Value, 9), 5.0);
        Check("dot distance is negated", SqliteVectors.VectorDistance(new List<double> { 1, 2 }, new List<double> { 2, 4 }, "dot").Value, -10.0);
        Check("mismatched dimensions", SqliteVectors.VectorDistance(new List<double> { 1, 2 }, new List<double> { 1, 2, 3 }, "cosine") == null, true);
        Check("is a VECTOR column", SqliteVectors.IsVectorField(new Dictionary<string, object> { ["sql"] = "VECTOR(3)" }), true);
        Check("is a TEXT column", SqliteVectors.IsVectorField(new Dictionary<string, object> { ["sql"] = "TEXT" }), false);

        Console.WriteLine("\n[sqlite vector strategy plan]");
        Check("a BLOB column drops the JSON strategy",
            string.Join(",", SqliteVectors.PlanStrategies(true, true, true, "BLOB", null)), "sqlite-vec,udf");
        Check("a TEXT column keeps the JSON strategy",
            string.Join(",", SqliteVectors.PlanStrategies(false, false, true, "TEXT", null)), "sql");
        Check("a pinned strategy wins",
            string.Join(",", SqliteVectors.PlanStrategies(true, true, true, "BLOB", "udf")), "udf");
        Check("memory is the caller's own path",
            SqliteVectors.PlanStrategies(true, true, true, "BLOB", "memory").Count, 0);

        Console.WriteLine("\n[sqlite vector search -> a BLOB column, ranked by the driver function]");
        var dbPath = Path.Combine(Path.GetTempPath(), "an5_dotnet_vector.db");
        if (File.Exists(dbPath)) File.Delete(dbPath);
        try
        {
            var nativePath = Environment.GetEnvironmentVariable("AN5_NATIVE_VECTOR_PATH");
            var vecAdapter = new An5Adapter(new An5AdapterOptions { ConnectionString = dbPath, SqliteVec = nativePath });
            if (!string.IsNullOrWhiteSpace(nativePath)) {
                Check("native C extension is loaded", vecAdapter.QueryRaw("SELECT an5_vector_version() AS v")[0]["v"], "an5-vector/1");
                var single = (double)(float)0.1;
                var measured = Convert.ToDouble(vecAdapter.QueryRaw("SELECT an5_vec_ip('[0.1]', '[0.1]') AS d")[0]["d"]);
                Check(".NET preserves the C function instead of replacing it", Math.Abs(measured + single * single) < 1e-12, true);
            }
            vecAdapter.ExecuteRaw("CREATE TABLE \"Vec\" (\"Id\" TEXT PRIMARY KEY, \"Embedding\" BLOB)");
            var insert = new Dictionary<string, object>();
            foreach (var pair in new[]
            {
                ("d1", new List<double> { 1, 0, 0 }),
                ("d2", new List<double> { 0.8, 0.2, 0 }),
                ("d3", new List<double> { 0, 1, 0 }),
            })
            {
                insert["Id"] = pair.Item1;
                insert["Embedding"] = SqliteVectors.EncodeVector(pair.Item2);
                vecAdapter.ExecuteRaw("INSERT INTO \"Vec\" (\"Id\", \"Embedding\") VALUES (@Id, @Embedding)", insert);
            }
            // A row with another dimension must never rank against a 3-dimension query.
            vecAdapter.ExecuteRaw(
                "INSERT INTO \"Vec\" (\"Id\", \"Embedding\") VALUES ('d4', @Embedding)",
                new Dictionary<string, object> { ["Embedding"] = SqliteVectors.EncodeVector(new List<double> { 1, 0, 0, 1 }) });

            var vecDocs = vecAdapter.Table<VecDoc>("Vec");
            var direct = vecAdapter.QueryRaw("SELECT an5_vec_cosine(Embedding, @q) AS distance FROM Vec WHERE Id = 'd1'",
                new Dictionary<string, object> { ["q"] = SqliteVectors.EncodeVector(new List<double> { 1, 0, 0 }) });
            Check("the registered SQL function runs", Convert.ToDouble(direct[0]["distance"]), 0.0);
            foreach (var metric in new[] { "cosine", "euclidean", "dot" })
            {
                var hits = vecDocs.VectorSearch(new List<double> { 1, 0, 0 }, take: 9, vectorField: "Embedding", distanceMetric: metric);
                Check($"{metric}: row order", string.Join(",", hits.Select(h => h.Item.Id)), "d1,d2,d3");
                Check($"{metric}: distance is a number", hits.All(h => !double.IsNaN(h.Distance)), true);
                Check($"{metric}: the vector decodes to numbers", hits[0].Item.Embedding.Length, 3);
                // Dot product ranks by -dot, so an exact match sits at -1 there.
                Check($"{metric}: closest distance", Math.Round(hits[0].Distance, 6),
                    metric == "dot" ? -1.0 : 0.0);
            }

            var whereHits = vecDocs.VectorSearch(
                new List<double> { 1, 0, 0 }, take: 5, vectorField: "Embedding",
                whereClause: "[Id] = @id",
                parameters: new Dictionary<string, object> { ["id"] = "d3" });
            Check("a where filter applies", string.Join(",", whereHits.Select(h => h.Item.Id)), "d3");

            var argsWhereHits = vecDocs.VectorSearch(new VectorSearchArgs
            {
                Vector = new List<double> { 1, 0, 0 },
                Take = 5,
                VectorField = "Embedding",
                Where = new Dictionary<string, object> { ["Id"] = "d2" },
            });
            Check("VectorSearchArgs Where filter applies", string.Join(",", argsWhereHits.Select(h => h.Item.Id)), "d2");

            vecAdapter.Dispose();

            // `VectorStrategy` pins the plan, so a project can force the in-process
            // fallback even on a connection that could rank in the database.
            var memoryAdapter = new An5Adapter(new An5AdapterOptions { ConnectionString = dbPath, VectorStrategy = "memory" });
            var memoryHits = memoryAdapter.Table<VecDoc>("Vec")
                .VectorSearch(new List<double> { 1, 0, 0 }, take: 9, vectorField: "Embedding");
            Check("the memory fallback ranks correctly", string.Join(",", memoryHits.Select(h => h.Item.Id)), "d1,d2,d3");
            Check("the memory fallback decodes the BLOB", memoryHits[0].Item.Embedding[0], 1.0f);
            memoryAdapter.Dispose();
        }
        finally
        {
            foreach (var suffix in new[] { "", "-wal", "-shm" })
                if (File.Exists(dbPath + suffix)) File.Delete(dbPath + suffix);
        }
    }

    public class Doc
    {
        public string Id { get; set; }
        public string Embedding { get; set; }
    }

    public class VecDoc
    {
        public string Id { get; set; }
        public float[] Embedding { get; set; }
    }

    private static object FromJson(System.Text.Json.JsonElement element)
    {
        switch (element.ValueKind)
        {
            case System.Text.Json.JsonValueKind.Object:
                return element.EnumerateObject().ToDictionary(p => p.Name, p => FromJson(p.Value));
            case System.Text.Json.JsonValueKind.Array:
                return element.EnumerateArray().Select(FromJson).ToList();
            case System.Text.Json.JsonValueKind.Number: return element.GetInt32();
            case System.Text.Json.JsonValueKind.String: return element.GetString();
            case System.Text.Json.JsonValueKind.True: return true;
            case System.Text.Json.JsonValueKind.False: return false;
            default: return null;
        }
    }

    private static void SharedQueryContract()
    {
        using var fixtures = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "query-semantics.json")));
        using var connection = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=:memory:");
        connection.Open();
        using (var setup = connection.CreateCommand())
        {
            setup.CommandText = "CREATE TABLE users (id INTEGER, score INTEGER); INSERT INTO users VALUES (1,0),(2,10),(3,20);";
            setup.ExecuteNonQuery();
        }
        foreach (var entry in fixtures.RootElement.GetProperty("cases").EnumerateArray())
        {
            var parameters = new Dictionary<string, object>();
            var clause = SqlBuilder.ParseWhere(FromJson(entry.GetProperty("where")), parameters, Dialect.Sqlite);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT id FROM users" + (clause.Length > 0 ? " WHERE " + clause : "") + " ORDER BY id";
            foreach (var parameter in parameters) command.Parameters.AddWithValue("@" + parameter.Key, parameter.Value ?? DBNull.Value);
            using var reader = command.ExecuteReader();
            var actual = new List<int>();
            while (reader.Read()) actual.Add(reader.GetInt32(0));
            var expected = entry.GetProperty("ids").EnumerateArray().Select(id => id.GetInt32());
            Check("shared query contract: " + entry.GetProperty("name").GetString(), string.Join(",", actual), string.Join(",", expected));
        }
    }

    private static void RelationFiltersAndValidation(string dbPath)
    {
        Console.WriteLine("\n[relation filters & strict validation]");
        An5AdapterMetadata.Set(new AdapterMetadata
        {
            ModelToTable = new Dictionary<string, string>
            {
                { "User", "dbo.rel_users" },
                { "Order", "dbo.rel_orders" },
                { "OrderItem", "dbo.rel_order_items" },
                { "Profile", "dbo.rel_profiles" },
                { "GrpOrder", "dbo.grp_orders" },
            },
            ModelFields = new Dictionary<string, object>
            {
                { "User", new Dictionary<string, bool> { { "id", true }, { "email", true }, { "created_at", true } } },
                { "Order", new Dictionary<string, bool> { { "id", true }, { "user_id", true }, { "total", true }, { "status", true } } },
                { "OrderItem", new Dictionary<string, bool> { { "id", true }, { "order_id", true }, { "sku", true } } },
                { "Profile", new Dictionary<string, bool> { { "id", true }, { "user_id", true }, { "bio", true } } },
                { "GrpOrder", new Dictionary<string, bool> { { "id", true }, { "status", true }, { "total", true }, { "note", true } } },
            },
            RelationMap = new Dictionary<string, Dictionary<string, RelationDef>>
            {
                { "User", new Dictionary<string, RelationDef>
                    {
                        { "orders", new RelationDef { ModelName = "Order", RelationType = "many", ForeignKey = "user_id", LocalKey = "id" } },
                        { "profile", new RelationDef { ModelName = "Profile", RelationType = "one", ForeignKey = "user_id", LocalKey = "id" } },
                    }
                },
                { "Order", new Dictionary<string, RelationDef>
                    {
                        { "user", new RelationDef { ModelName = "User", RelationType = "one", ForeignKey = "user_id", LocalKey = "id" } },
                        { "order_items", new RelationDef { ModelName = "OrderItem", RelationType = "many", ForeignKey = "order_id", LocalKey = "id" } },
                    }
                },
                { "OrderItem", new Dictionary<string, RelationDef>
                    {
                        { "order", new RelationDef { ModelName = "Order", RelationType = "one", ForeignKey = "order_id", LocalKey = "id" } },
                    }
                },
                { "Profile", new Dictionary<string, RelationDef>
                    {
                        { "user", new RelationDef { ModelName = "User", RelationType = "one", ForeignKey = "user_id", LocalKey = "id" } },
                    }
                },
            },
        });

        try
        {
            var manyKeys = An5AdapterMetadata.ResolveRelationKeys("User", new RelationDef { ModelName = "Order", RelationType = "many", ForeignKey = "user_id", LocalKey = "id" });
            Check("ResolveRelationKeys User.orders", $"{manyKeys.ChildCol}:{manyKeys.ParentCol}", "user_id:id");

            var toOneFkKeys = An5AdapterMetadata.ResolveRelationKeys("Order", new RelationDef { ModelName = "User", RelationType = "one", ForeignKey = "user_id", LocalKey = "id" });
            Check("ResolveRelationKeys Order.user", $"{toOneFkKeys.ChildCol}:{toOneFkKeys.ParentCol}", "id:user_id");

            var inverseKeys = An5AdapterMetadata.ResolveRelationKeys("User", new RelationDef { ModelName = "Profile", RelationType = "one", ForeignKey = "user_id", LocalKey = "id" });
            Check("ResolveRelationKeys User.profile inverse 1-to-1", $"{inverseKeys.ChildCol}:{inverseKeys.ParentCol}", "user_id:id");

            using var setupConn = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={dbPath}");
            setupConn.Open();
            using (var setup = setupConn.CreateCommand())
            {
                setup.CommandText = @"
CREATE TABLE rel_users (id INTEGER PRIMARY KEY, email TEXT, created_at TEXT);
CREATE TABLE rel_profiles (id INTEGER PRIMARY KEY, user_id INTEGER, bio TEXT);
CREATE TABLE rel_orders (id INTEGER PRIMARY KEY, user_id INTEGER, total INTEGER, status TEXT);
CREATE TABLE rel_order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT);
INSERT INTO rel_users VALUES (1,'alice@example.com','2026-01-01'),(2,'bob@example.com','2026-01-02'),(3,'carol@example.com','2026-01-03');
INSERT INTO rel_profiles VALUES (10,1,'VIP buyer'),(11,3,'New buyer');
INSERT INTO rel_orders VALUES (100,1,150,'paid'),(101,1,60,'open'),(102,2,40,'cancelled'),(103,99,200,'paid');
INSERT INTO rel_order_items VALUES (1000,100,'AN5-PRO'),(1001,102,'BASIC');";
                setup.ExecuteNonQuery();
            }

            var adapter = new An5Adapter($"sqlite:{dbPath}");
            var usersTbl = adapter.Table<RelUser>("User");
            var ordersTbl = adapter.Table<RelOrder>("Order");

            var someUsers = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "some", new Dictionary<string, object> { { "status", "paid" }, { "total", new Dictionary<string, object> { { "gte", 100 } } } } } } } },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("some orders paid >= 100", string.Join(",", someUsers.Select(u => u.Id)), "1");

            var noneCancelled = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "none", new Dictionary<string, object> { { "status", "cancelled" } } } } } },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("none cancelled", string.Join(",", noneCancelled.Select(u => u.Id)), "1,3");

            var everyBig = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "every", new Dictionary<string, object> { { "total", new Dictionary<string, object> { { "gte", 50 } } } } } } } },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("every total >= 50", string.Join(",", everyBig.Select(u => u.Id)), "1,3");

            var combinedSomeEvery = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object>
                {
                    { "orders", new Dictionary<string, object>
                        {
                            { "some", new Dictionary<string, object> { { "status", new Dictionary<string, object> { { "not", new Dictionary<string, object> { { "equals", "cancelled" } } } } } } },
                            { "every", new Dictionary<string, object> { { "total", new Dictionary<string, object> { { "gte", 50 } } } } },
                        }
                    },
                },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("combined some + every + nested scalar not", string.Join(",", combinedSomeEvery.Select(u => u.Id)), "1");

            var multiHop = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object>
                {
                    { "orders", new Dictionary<string, object> { { "some", new Dictionary<string, object> { { "order_items", new Dictionary<string, object> { { "some", new Dictionary<string, object> { { "sku", "AN5-PRO" } } } } } } } } },
                    { "created_at", new Dictionary<string, object> { { "gte", "2026-01-01" } } },
                    { "user_compound", new Dictionary<string, object> { { "email", "alice@example.com" } } },
                },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("multi-hop + cleanWhere protection/flattening", string.Join(",", multiHop.Select(u => u.Id)), "1");

            var inverseIs = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "profile", new Dictionary<string, object> { { "is", new Dictionary<string, object> { { "bio", new Dictionary<string, object> { { "contains", "vip" }, { "mode", "insensitive" } } } } } } } },
                Include = new Dictionary<string, object> { { "profile", true }, { "_count", true } },
            });
            Check("inverse 1-to-1 profile.is mode=insensitive", string.Join(",", inverseIs.Select(u => u.Id)), "1");
            Check("inverse 1-to-1 Include profile bio", inverseIs.Count == 1 && inverseIs[0].Profile != null ? inverseIs[0].Profile["bio"] : null, "VIP buyer");
            Check("Include _count orders", inverseIs.Count == 1 && inverseIs[0]._count != null ? inverseIs[0]._count["orders"] : null, 2);

            var inverseIsNull = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "profile", new Dictionary<string, object> { { "is", null } } } },
            });
            Check("inverse 1-to-1 profile.is null", string.Join(",", inverseIsNull.Select(u => u.Id)), "2");

            var inverseIsNotNull = usersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "profile", new Dictionary<string, object> { { "isNot", null } } } },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("inverse 1-to-1 profile.isNot null", string.Join(",", inverseIsNotNull.Select(u => u.Id)), "1,3");

            var fkToOneIs = ordersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "user", new Dictionary<string, object> { { "is", new Dictionary<string, object> { { "email", "alice@example.com" } } } } } },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("Order.user is alice", string.Join(",", fkToOneIs.Select(o => o.Id)), "100,101");

            var fkToOneIsNot = ordersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "user", new Dictionary<string, object> { { "is_not", new Dictionary<string, object> { { "email", "alice@example.com" } } } } } },
                OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            });
            Check("Order.user is_not alice", string.Join(",", fkToOneIsNot.Select(o => o.Id)), "102,103");

            var fkToOneNull = ordersTbl.FindMany(new FindManyArgs
            {
                Where = new Dictionary<string, object> { { "user", new Dictionary<string, object> { { "is", null } } } },
            });
            Check("Order.user is null (orphan)", string.Join(",", fkToOneNull.Select(o => o.Id)), "103");

            // Strict validation rejections
            CheckThrows<ArgumentException>("reject unknown scalar op", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "email", new Dictionary<string, object> { { "bogus", "x" } } } } }));
            CheckThrows<ArgumentException>("reject relation op on scalar", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "email", new Dictionary<string, object> { { "some", new Dictionary<string, object>() } } } } }));
            CheckThrows<ArgumentException>("reject to-one op on to-many", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "is", new Dictionary<string, object>() } } } } }));
            CheckThrows<ArgumentException>("reject to-many op on to-one", () =>
                ordersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "user", new Dictionary<string, object> { { "some", new Dictionary<string, object>() } } } } }));
            CheckThrows<ArgumentException>("reject unknown relation op", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "any", new Dictionary<string, object>() } } } } }));
            CheckThrows<ArgumentException>("reject non-dict relation value", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "orders", "bad" } } }));
            CheckThrows<ArgumentException>("reject null some relation filter", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "some", null } } } } }));
            CheckThrows<ArgumentException>("reject non-collection in operator", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "email", new Dictionary<string, object> { { "in", "not-a-list" } } } } }));
            CheckThrows<ArgumentException>("reject non-string contains", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "email", new Dictionary<string, object> { { "contains", 42 } } } } }));
            CheckThrows<ArgumentException>("reject invalid filter mode", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "email", new Dictionary<string, object> { { "mode", "fuzzy" }, { "equals", "a" } } } } }));
            CheckThrows<ArgumentException>("reject unknown model field", () =>
                usersTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "unknown_field", "x" } } }));
            CheckThrows<ArgumentException>("reject non-dict where", () =>
                usersTbl.FindMany(new FindManyArgs { Where = "not-a-dict" }));

            IncludePaginationAndFilteredCount(adapter);
            GroupByHavingAndInsensitiveFilters(adapter);
        }
        finally
        {
            An5AdapterMetadata.Set(new AdapterMetadata());
        }
    }

    private static void IncludePaginationAndFilteredCount(An5Adapter adapter)
    {
        Console.WriteLine("\n[include pagination, filtered _count, AND where composition, select+include preservation]");
        adapter.ExecuteRaw("INSERT INTO rel_orders VALUES (104,1,220,'paid'),(105,2,180,'paid'),(106,2,210,'paid');");
        var usersTbl = adapter.Table<RelUser>("User");

        var users = usersTbl.FindMany(new FindManyArgs
        {
            OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            Select = new List<string> { "Email" },
            Include = new Dictionary<string, object>
            {
                {
                    "orders", new Dictionary<string, object>
                    {
                        { "where", new Dictionary<string, object> { { "user_id", new Dictionary<string, object> { { "in", new List<object> { 1, 2 } } } } } },
                        { "orderBy", new Dictionary<string, object> { { "id", "asc" } } },
                        { "skip", 1 },
                        { "take", 1 },
                        { "select", new List<string> { "id", "total" } },
                        {
                            "include", new Dictionary<string, object>
                            {
                                { "user", new Dictionary<string, object> { { "select", new List<string> { "email" } } } },
                            }
                        },
                    }
                },
                {
                    "_count", new Dictionary<string, object>
                    {
                        {
                            "select", new Dictionary<string, object>
                            {
                                { "orders", new Dictionary<string, object> { { "where", new Dictionary<string, object> { { "status", "paid" } } } } },
                            }
                        },
                    }
                },
            },
        });

        Check("include parity: parent count", users.Count, 3);
        Check("include parity: Select strips Id while preserving Email", users[0].Id == 0 && users[0].Email == "alice@example.com", true);
        Check("include parity: alice filtered _count.orders == 2", Convert.ToInt32(users[0]._count["orders"]), 2);
        Check("include parity: bob filtered _count.orders == 2", Convert.ToInt32(users[1]._count["orders"]), 2);
        Check("include parity: carol filtered _count.orders == 0", Convert.ToInt32(users[2]._count["orders"]), 0);
        Check("include parity: alice per-parent skip=1,take=1 -> [101]", users[0].Orders.Count == 1 && Convert.ToInt32(users[0].Orders[0]["id"]) == 101, true);
        Check("include parity: alice nested select strips user_id", users[0].Orders[0].ContainsKey("user_id"), false);
        var nestedUser = users[0].Orders[0]["user"] as Dictionary<string, object>;
        Check("include parity: alice nested user email preserved", nestedUser != null ? nestedUser["email"] : null, "alice@example.com");
        Check("include parity: bob per-parent skip=1,take=1 -> [105]", users[1].Orders.Count == 1 && Convert.ToInt32(users[1].Orders[0]["id"]) == 105, true);
        Check("include parity: carol orders empty", users[2].Orders.Count, 0);

        var zeroTake = usersTbl.FindMany(new FindManyArgs
        {
            OrderBy = new Dictionary<string, object> { { "id", "asc" } },
            Include = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "take", 0 } } } },
        });
        Check("include parity: take=0 yields empty lists", zeroTake.All(u => u.Orders.Count == 0), true);

        CheckThrows<ArgumentException>("include parity: reject negative take", () =>
            usersTbl.FindMany(new FindManyArgs { Include = new Dictionary<string, object> { { "orders", new Dictionary<string, object> { { "take", -1 } } } } }));
        CheckThrows<ArgumentException>("include parity: reject unknown _count relation", () =>
            usersTbl.FindMany(new FindManyArgs { Include = new Dictionary<string, object> { { "_count", new Dictionary<string, object> { { "select", new Dictionary<string, object> { { "bogus", true } } } } } } }));
    }

    private static void GroupByHavingAndInsensitiveFilters(An5Adapter adapter)
    {
        Console.WriteLine("\n[groupBy having, per-field count, insensitive in/notIn, strict scalar validation]");
        adapter.ExecuteRaw(@"
CREATE TABLE grp_orders (id INTEGER PRIMARY KEY, status TEXT, total INTEGER, note TEXT);
INSERT INTO grp_orders VALUES
  (1, 'paid', 150, 'vip'),
  (2, 'paid', 50, NULL),
  (3, 'open', 120, 'hold'),
  (4, 'cancelled', 40, NULL);");

        var grpTbl = adapter.Table<GrpOrder>("GrpOrder");

        // Case-insensitive in / notIn
        var inCi = grpTbl.FindMany(new FindManyArgs
        {
            Where = new Dictionary<string, object>
            {
                { "status", new Dictionary<string, object> { { "in", new List<object> { "PAID", "OPEN" } }, { "mode", "insensitive" } } },
            },
            OrderBy = new Dictionary<string, object> { { "id", "asc" } },
        });
        Check("in mode=insensitive ids", string.Join(",", inCi.Select(r => r.Id)), "1,2,3");

        var notInCi = grpTbl.FindMany(new FindManyArgs
        {
            Where = new Dictionary<string, object>
            {
                { "status", new Dictionary<string, object> { { "notIn", new List<object> { "PAID" } }, { "mode", "insensitive" } } },
            },
            OrderBy = new Dictionary<string, object> { { "id", "asc" } },
        });
        Check("notIn mode=insensitive ids", string.Join(",", notInCi.Select(r => r.Id)), "3,4");

        // Aggregate with per-field _count and string min/max preservation
        var agg = grpTbl.Aggregate(new AggregateArgs
        {
            Count = new Dictionary<string, object> { { "_all", true }, { "note", true } },
            Sum = new List<string> { "total" },
            Avg = new List<string> { "total" },
            Min = new List<string> { "status", "total" },
            Max = new List<string> { "status", "total" },
        });
        var aggCount = (Dictionary<string, object>)agg["_count"];
        var aggMin = (Dictionary<string, object>)agg["_min"];
        var aggMax = (Dictionary<string, object>)agg["_max"];
        var aggSum = (Dictionary<string, object>)agg["_sum"];
        var aggAvg = (Dictionary<string, object>)agg["_avg"];
        Check("aggregate _count._all", aggCount["_all"], 4);
        Check("aggregate _count.note", aggCount["note"], 2);
        Check("aggregate _min.status string", aggMin["status"], "cancelled");
        Check("aggregate _max.status string", aggMax["status"], "paid");
        Check("aggregate _sum.total", aggSum["total"], 360);
        Check("aggregate _avg.total", aggAvg["total"], 90);

        // GroupBy with Having (OR, NOT, _count._all, _sum), per-field _count, OrderBy
        var grouped = grpTbl.GroupBy(new GroupByArgs
        {
            By = new List<string> { "status" },
            Count = new Dictionary<string, object> { { "_all", true }, { "note", true } },
            Sum = new List<string> { "total" },
            Avg = new List<string> { "total" },
            Min = new List<string> { "total" },
            Max = new List<string> { "total" },
            Having = new Dictionary<string, object>
            {
                { "OR", new List<object>
                    {
                        new Dictionary<string, object> { { "_count", new Dictionary<string, object> { { "_all", new Dictionary<string, object> { { "gte", 2 } } } } } },
                        new Dictionary<string, object> { { "_sum", new Dictionary<string, object> { { "total", new Dictionary<string, object> { { "gte", 120 } } } } } },
                    }
                },
                { "NOT", new Dictionary<string, object> { { "status", "cancelled" } } },
            },
            OrderBy = new Dictionary<string, object> { { "status", "asc" } },
        });
        Check("groupBy having statuses", string.Join(",", grouped.Select(r => r["status"])), "open,paid");
        var paid = grouped[1];
        var paidCount = (Dictionary<string, object>)paid["_count"];
        var paidSum = (Dictionary<string, object>)paid["_sum"];
        var paidAvg = (Dictionary<string, object>)paid["_avg"];
        var paidMin = (Dictionary<string, object>)paid["_min"];
        var paidMax = (Dictionary<string, object>)paid["_max"];
        Check("paid _count._all", paidCount["_all"], 2);
        Check("paid _count.note", paidCount["note"], 1);
        Check("paid _sum.total", paidSum["total"], 200);
        Check("paid _avg.total", paidAvg["total"], 100);
        Check("paid _min.total", paidMin["total"], 50);
        Check("paid _max.total", paidMax["total"], 150);

        // GroupBy with grouped scalar field in Having using insensitive IN
        var paidOnly = grpTbl.GroupBy(new GroupByArgs
        {
            By = new List<string> { "status" },
            Having = new Dictionary<string, object>
            {
                { "status", new Dictionary<string, object> { { "in", new List<object> { "PAID" } }, { "mode", "insensitive" } } },
                { "_count", new Dictionary<string, object> { { "note", 1 } } },
                { "_min", new Dictionary<string, object> { { "total", new Dictionary<string, object> { { "lte", 50 } } } } },
            },
        });
        Check("groupBy having grouped scalar + _count.note + _min", string.Join(",", paidOnly.Select(r => r["status"])), "paid");

        // GroupBy offset-only pagination on SQLite (LIMIT -1 OFFSET 1)
        var offsetOnly = grpTbl.GroupBy(new GroupByArgs
        {
            By = new List<string> { "status" },
            OrderBy = new Dictionary<string, object> { { "status", "asc" } },
            Skip = 1,
        });
        Check("groupBy skip-only statuses", string.Join(",", offsetOnly.Select(r => r["status"])), "open,paid");

        // Strict validation rejections
        CheckThrows<ArgumentException>("reject ungrouped scalar in having", () =>
            grpTbl.GroupBy(new GroupByArgs
            {
                By = new List<string> { "status" },
                Having = new Dictionary<string, object> { { "total", new Dictionary<string, object> { { "gte", 100 } } } },
            }));
        CheckThrows<ArgumentException>("reject _all inside _sum in having", () =>
            grpTbl.GroupBy(new GroupByArgs
            {
                By = new List<string> { "status" },
                Having = new Dictionary<string, object> { { "_sum", new Dictionary<string, object> { { "_all", 1 } } } },
            }));
        CheckThrows<ArgumentException>("reject unknown field in having", () =>
            grpTbl.GroupBy(new GroupByArgs
            {
                By = new List<string> { "status" },
                Having = new Dictionary<string, object> { { "_count", new Dictionary<string, object> { { "bogus", 1 } } } },
            }));
        CheckThrows<ArgumentException>("reject non-list OR in where", () =>
            grpTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "OR", new Dictionary<string, object> { { "status", "paid" } } } } }));
        CheckThrows<ArgumentException>("reject non-list OR in having", () =>
            grpTbl.GroupBy(new GroupByArgs
            {
                By = new List<string> { "status" },
                Having = new Dictionary<string, object> { { "OR", new Dictionary<string, object> { { "status", "paid" } } } },
            }));
        CheckThrows<ArgumentException>("reject collection on direct scalar field", () =>
            grpTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "status", new List<object> { "paid" } } } }));
        CheckThrows<ArgumentException>("reject collection on equals", () =>
            grpTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "status", new Dictionary<string, object> { { "equals", new List<object> { "paid" } } } } } }));
        CheckThrows<ArgumentException>("reject collection on not", () =>
            grpTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "status", new Dictionary<string, object> { { "not", new List<object> { "paid" } } } } } }));
        CheckThrows<ArgumentException>("reject collection on gt", () =>
            grpTbl.FindMany(new FindManyArgs { Where = new Dictionary<string, object> { { "total", new Dictionary<string, object> { { "gt", new List<object> { 10 } } } } } }));
    }

    private static int Main()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"an5-sqlite-smoke-{Guid.NewGuid():N}.db");

        try
        {
            SharedQueryContract();
            DialectDetection();
            Normalisation();
            Quoting();
            RelationFiltersAndValidation(_dbPath);

            var adapter = new An5Adapter($"sqlite:{_dbPath}");
            Crud(adapter);
            Transactions(adapter);
            StoredProcedures(adapter);
            VectorSearch(adapter);
            SqliteVectorSearch();
        }
        finally
        {
            try { File.Delete(_dbPath); } catch { }
        }

        Console.WriteLine();
        if (_failed > 0)
        {
            Console.WriteLine($"{_failed} CHECK FAIL");
            return 1;
        }

        Console.WriteLine("TAT CA CHECK PASS");
        return 0;
    }
}
