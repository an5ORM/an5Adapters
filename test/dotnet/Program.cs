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
// exercised, not just ASCII text.

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
        Console.WriteLine("\n[vector search -> in-memory fallback]");
        adapter.ExecuteRaw("CREATE TABLE \"Doc\" (\"Id\" TEXT PRIMARY KEY, \"Embedding\" TEXT)");
        adapter.ExecuteRaw(
            "INSERT INTO \"Doc\" VALUES ('d1', '[1.0, 0.0]'), ('d2', '[0.0, 1.0]'), ('d3', '[0.9, 0.1]')");

        var docs = adapter.Table<Doc>("Doc");
        var hits = docs.VectorSearch(new List<double> { 1.0, 0.0 }, take: 2, vectorField: "Embedding");
        Check("hit count", hits.Count, 2);
        Check("closest first", hits[0].Item.Id, "d1");
        Check("distance ordered", hits[0].Distance <= hits[1].Distance, true);
    }

    public class Doc
    {
        public string Id { get; set; }
        public string Embedding { get; set; }
    }

    private static int Main()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"an5-sqlite-smoke-{Guid.NewGuid():N}.db");

        try
        {
            DialectDetection();
            Normalisation();
            Quoting();

            var adapter = new An5Adapter($"sqlite:{_dbPath}");
            Crud(adapter);
            Transactions(adapter);
            StoredProcedures(adapter);
            VectorSearch(adapter);
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
