using System;
using System.Collections.Generic;
using System.Data.Common;

namespace An5Orm
{
public enum Dialect
    {
        Mssql,
        Postgres,
        Sqlite
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

    // ─── Connection scope ──────────────────────────────────────────────────────

    /// <summary>
    /// A connection borrowed for the length of one operation, and whether the
    /// caller still owns it.
    ///
    /// A statement issued while a transaction is open has to run on that
    /// transaction's connection. Opening a second one is not merely wasteful: on
    /// SQLite the open transaction holds a write lock, so the second connection
    /// is refused with "database is locked", and on the server engines the write
    /// silently lands outside the transaction, so commit and rollback do not
    /// cover it. Each engine keeps the transaction connection and hands it back
    /// through this scope while it is set.
    /// </summary>
    internal readonly struct ConnectionScope<T> : IDisposable where T : class
    {
        public T Connection { get; }

        private readonly bool _owned;

        internal ConnectionScope(T connection, bool owned)
        {
            Connection = connection;
            _owned = owned;
        }

        public void Dispose()
        {
            if (_owned && Connection is IDisposable disposable) disposable.Dispose();
        }
    }

// ─── Dialect detection ─────────────────────────────────────────────────────

    internal static class DialectDetector
    {
        public static Dialect Detect(string connectionString)
        {
            var cs = (connectionString ?? "").Trim().ToLowerInvariant();
            // SQLite first: `Data Source=app.db` and a bare file path would
            // otherwise fall through, and a Postgres string never looks like
            // any of these.
            if (cs.StartsWith("sqlite:") || cs.StartsWith("file:") || cs == ":memory:"
                || cs.Contains("data source=") || cs.Contains("datasource=")
                || cs.EndsWith(".db") || cs.EndsWith(".sqlite") || cs.EndsWith(".sqlite3"))
                return Dialect.Sqlite;
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
            if (dialect == Dialect.Postgres || dialect == Dialect.Sqlite)
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

    // ─── Metadata registry ────────────────────────────────────────────────────

    public class RelationDef
    {
        public string ModelName { get; set; }
        public string RelationType { get; set; } // "many" | "one"
        public string ForeignKey { get; set; }
        public string LocalKey { get; set; }
    }

    public class AdapterMetadata
    {
        public Dictionary<string, string> ModelToTable { get; set; } = new();
        public Dictionary<string, object> ModelFields { get; set; } = new();
        public Dictionary<string, Dictionary<string, RelationDef>> RelationMap { get; set; } = new();
    }

    internal static class An5Metadata
    {
        private static readonly object _lock = new();
        private static Dictionary<string, string> _modelToTable = new();
        private static Dictionary<string, object> _modelFields = new();
        private static Dictionary<string, Dictionary<string, RelationDef>> _relationMap = new();

        public static void SetAdapterMetadata(AdapterMetadata meta)
        {
            lock (_lock)
            {
                _modelToTable = meta?.ModelToTable != null ? new Dictionary<string, string>(meta.ModelToTable) : new();
                _modelFields = meta?.ModelFields != null ? new Dictionary<string, object>(meta.ModelFields) : new();
                _relationMap = new Dictionary<string, Dictionary<string, RelationDef>>();
                if (meta?.RelationMap != null)
                {
                    foreach (var kv in meta.RelationMap)
                    {
                        _relationMap[kv.Key] = new Dictionary<string, RelationDef>(kv.Value);
                    }
                }
            }
        }

        public static Dictionary<string, string> GetModelToTable()
        {
            lock (_lock) return new Dictionary<string, string>(_modelToTable);
        }

        public static object GetFieldsForModel(string modelName)
        {
            lock (_lock)
            {
                return _modelFields.TryGetValue(modelName, out var v) ? v : null;
            }
        }

        public static Dictionary<string, RelationDef> GetRelationsForModel(string modelName)
        {
            lock (_lock)
            {
                return _relationMap.TryGetValue(modelName, out var r) ? new Dictionary<string, RelationDef>(r) : new Dictionary<string, RelationDef>();
            }
        }
    }

    // ─── Where / OrderBy builder ───────────────────────────────────────────────
    // Mirrors the TypeScript parseWhere/buildOrderBy used by the reference adapter.

    internal static class SqlBuilder
    {
        private static readonly string[] OperatorKeys =
        { "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt" };

        private static bool IsOperatorValue(object value)
        {
            if (!(value is Dictionary<string, object> dict)) return false;
            foreach (var op in OperatorKeys)
                if (dict.ContainsKey(op)) return true;
            return false;
        }

        internal static string SanitizeParamName(string name)
        {
            var sb = new System.Text.StringBuilder();
            foreach (var ch in (name ?? ""))
                sb.Append(char.IsLetterOrDigit(ch) || ch == '_' ? ch : '_');
            var cleaned = sb.ToString();
            return cleaned.Length > 0 && char.IsLetter(cleaned[0]) ? cleaned : "p_" + cleaned;
        }

        private static string NormalizeSortDirection(object direction)
        {
            return direction is string s && s.ToUpperInvariant() == "DESC" ? "DESC" : "ASC";
        }

        private static string Placeholder(string paramName) => "@" + paramName;

        public static string BuildOrderBy(object orderBy, Dialect dialect)
        {
            if (orderBy == null) return "";
            var entries = orderBy is System.Collections.IList list ? list : new List<object> { orderBy };
            var parts = new List<string>();
            foreach (var entry in entries)
            {
                if (!(entry is Dictionary<string, object> map)) continue;
                foreach (var kv in map)
                    parts.Add($"{SqlQuote.QuoteName(kv.Key, dialect)} {NormalizeSortDirection(kv.Value)}");
            }
            return parts.Count > 0 ? "ORDER BY " + string.Join(", ", parts) : "";
        }

        public static string ParseWhere(object where, Dictionary<string, object> parameters, Dialect dialect, string prefix = "")
        {
            if (!(where is Dictionary<string, object> dict) || dict.Count == 0) return "";

            var clean = new Dictionary<string, object>();
            foreach (var kv in dict)
            {
                if (kv.Key.Contains("_") && kv.Value is Dictionary<string, object> inner && !IsOperatorValue(inner))
                {
                    foreach (var sub in inner) clean[sub.Key] = sub.Value;
                }
                else
                {
                    clean[kv.Key] = kv.Value;
                }
            }

            var conditions = new List<string>();
            foreach (var kv in clean)
            {
                var key = kv.Key;
                var value = kv.Value;
                if (key == "OR" || key == "AND" || key == "NOT")
                {
                    var items = value is System.Collections.IList list
                        ? list : new object[] { value };
                    var subs = new List<string>();
                    var i = 0;
                    foreach (var item in items)
                    {
                        if (item is Dictionary<string, object> subMap)
                        {
                            var s = ParseWhere(subMap, parameters, dialect, $"{prefix}{key}{i++}_");
                            subs.Add(string.IsNullOrEmpty(s) ? "1=1" : s);
                        }
                    }
                    if (subs.Count == 0)
                    {
                        if (key == "OR") conditions.Add("1=0");
                    }
                    else
                    {
                        var joiner = key == "AND" ? " AND " : " OR ";
                        var negation = key == "NOT" ? "NOT " : "";
                        conditions.Add(negation + "(" + string.Join(joiner, subs) + ")");
                    }
                    continue;
                }

                var col = SqlQuote.QuoteName(key, dialect);
                var baseName = SanitizeParamName($"{prefix}{key}");
                if (value == null)
                {
                    conditions.Add($"{col} IS NULL");
                }
                else if (value is Dictionary<string, object> opMap)
                {
                    foreach (var op in OperatorKeys)
                    {
                        if (!opMap.TryGetValue(op, out var opVal)) continue;
                        switch (op)
                        {
                            case "not":
                                if (opVal == null) conditions.Add($"{col} IS NOT NULL");
                                else if (opVal is Dictionary<string, object> nested)
                                {
                                    var s = ParseWhere(new Dictionary<string, object> { { key, nested } }, parameters, dialect, $"{prefix}{key}_not_");
                                    if (!string.IsNullOrEmpty(s)) conditions.Add("NOT (" + s + ")");
                                }
                                else { parameters[baseName + "_not"] = opVal; conditions.Add($"{col} <> {Placeholder(baseName + "_not")}"); }
                                break;
                            case "equals":
                                if (opVal == null) conditions.Add($"{col} IS NULL");
                                else { parameters[baseName + "_eq"] = opVal; conditions.Add($"{col} = {Placeholder(baseName + "_eq")}"); }
                                break;
                            case "contains":
                                parameters[baseName + "_co"] = "%" + opVal + "%"; conditions.Add($"{col} LIKE {Placeholder(baseName + "_co")}");
                                break;
                            case "startsWith":
                                parameters[baseName + "_sw"] = opVal + "%"; conditions.Add($"{col} LIKE {Placeholder(baseName + "_sw")}");
                                break;
                            case "endsWith":
                                parameters[baseName + "_ew"] = "%" + opVal; conditions.Add($"{col} LIKE {Placeholder(baseName + "_ew")}");
                                break;
                            case "gte":
                                parameters[baseName + "_gte"] = opVal; conditions.Add($"{col} >= {Placeholder(baseName + "_gte")}");
                                break;
                            case "lte":
                                parameters[baseName + "_lte"] = opVal; conditions.Add($"{col} <= {Placeholder(baseName + "_lte")}");
                                break;
                            case "gt":
                                parameters[baseName + "_gt"] = opVal; conditions.Add($"{col} > {Placeholder(baseName + "_gt")}");
                                break;
                            case "lt":
                                parameters[baseName + "_lt"] = opVal; conditions.Add($"{col} < {Placeholder(baseName + "_lt")}");
                                break;
                            case "in":
                            case "notIn":
                                if (opVal is System.Collections.IList vals && vals.Count > 0)
                                {
                                    var phs = new List<string>();
                                    var idx = 0;
                                    foreach (var v in vals)
                                    {
                                        var pn = op == "in" ? $"{baseName}_in{idx}" : $"{baseName}_notin{idx}";
                                        parameters[pn] = v;
                                        phs.Add(Placeholder(pn));
                                        idx++;
                                    }
                                    conditions.Add(op == "in"
                                        ? $"{col} IN ({string.Join(", ", phs)})"
                                        : $"{col} NOT IN ({string.Join(", ", phs)})");
                                }
                                else
                                {
                                    conditions.Add(op == "in" ? "1=0" : "1=1");
                                }
                                break;
                        }
                    }
                }
                else
                {
                    parameters[baseName] = value;
                    conditions.Add($"{col} = {Placeholder(baseName)}");
                }
            }
            return string.Join(" AND ", conditions);
        }
    }
}
