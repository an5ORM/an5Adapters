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

    private static int Main()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"an5-sqlite-smoke-{Guid.NewGuid():N}.db");

        try
        {
            SharedQueryContract();
            DialectDetection();
            Normalisation();
            Quoting();

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
