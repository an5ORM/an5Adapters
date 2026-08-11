using System;
using System.Collections.Generic;
using System.Data.Common;

namespace An5Orm
{
public enum Dialect
    {
        Mssql,
        Postgres
    }

    // ─── Config ────────────────────────────────────────────────────────────────

    public class An5AdapterOptions
    {
        public string ConnectionString { get; set; }
        public int CommandTimeout { get; set; } = 60;
        public int ConnectRetryCount { get; set; } = 3;
    }

    // ─── Query Engine Interface ────────────────────────────────────────────────

    internal interface IQueryEngine
    {
        Dialect Dialect { get; }
        List<Dictionary<string, object>> QueryRaw(string sql, Dictionary<string, object> parameters);
        List<T> QueryRaw<T>(string sql, Dictionary<string, object> parameters) where T : new();
        int ExecuteRaw(string sql, Dictionary<string, object> parameters);
        An5TransactionBase BeginTransaction();
    }

    // ─── Transaction base ──────────────────────────────────────────────────────

    internal abstract class An5TransactionBase : IDisposable
    {
        public abstract void Commit();
        public abstract void Rollback();
        public abstract void Dispose();
    }

// ─── Dialect detection ─────────────────────────────────────────────────────

    internal static class DialectDetector
    {
        public static Dialect Detect(string connectionString)
        {
            var cs = (connectionString ?? "").Trim().ToLowerInvariant();
            if (cs.StartsWith("postgres://") || cs.StartsWith("postgresql://") || cs.Contains("host="))
                return Dialect.Postgres;
            return Dialect.Mssql;
        }
    }

// ─── Quoting ───────────────────────────────────────────────────────────────

    internal static class SqlQuote
    {
        private static string StripWrapping(string name, string left, string right)
        {
            return name.StartsWith(left) && name.EndsWith(right)
                ? name.Substring(left.Length, name.Length - left.Length - right.Length)
                : name;
        }

        public static string QuoteName(string name, Dialect dialect)
        {
            var raw = name ?? "";
            if (dialect == Dialect.Postgres)
            {
                var unwrapped = StripWrapping(StripWrapping(raw, "[", "]"), "\"", "\"");
                return "\"" + unwrapped.Replace("\"", "\"\"") + "\"";
            }
            var bracketless = StripWrapping(raw, "[", "]");
            return "[" + bracketless.Replace("]", "]]") + "]";
        }

        public static string QuoteTable(string tableName, Dialect dialect)
        {
            if (tableName.StartsWith("[") || tableName.StartsWith("\""))
                return tableName;
            if (tableName.Contains("."))
            {
                var parts = tableName.Split('.');
                return string.Join(".", Array.ConvertAll(parts, p => QuoteName(p, dialect)));
            }
            return QuoteName(tableName, dialect);
        }
    }
}
