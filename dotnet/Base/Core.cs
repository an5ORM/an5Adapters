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
        /// <summary>
        /// SQLite only: path to the sqlite-vec extension binary. Loaded on every
        /// connection so vector search ranks inside the database. Other
        /// providers ignore it.
        /// </summary>
        public string SqliteVec { get; set; }
        /// <summary>
        /// SQLite only: pin one of "sqlite-vec" | "udf" | "sql" | "memory"
        /// instead of probing for the fastest strategy available.
        /// </summary>
        public string VectorStrategy { get; set; }
    }

    // ─── Query Engine Interface ────────────────────────────────────────────────

    internal interface IQueryEngine
    {
        Dialect Dialect { get; }
        List<Dictionary<string, object>> QueryRaw(string sql, Dictionary<string, object> parameters);
        List<T> QueryRaw<T>(string sql, Dictionary<string, object> parameters) where T : new();
        int ExecuteRaw(string sql, Dictionary<string, object> parameters);
        An5TransactionBase BeginTransaction();

        /// <summary>SQLite only: extension loading and distance-function registration.</summary>
        SqliteVectorSupport VectorSupport { get; }
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

        private static string StripTableSegmentWrapping(string name)
        {
            var raw = (name ?? "").Trim();
            raw = StripWrapping(raw, "[", "]");
            raw = StripWrapping(raw, "\"", "\"");
            raw = StripWrapping(raw, "`", "`");
            return raw;
        }

        public static string QuoteTable(string tableName, Dialect dialect)
        {
            var rawParts = (tableName ?? "").Split('.');
            var cleaned = new List<string>(rawParts.Length);
            foreach (var part in rawParts)
            {
                var seg = StripTableSegmentWrapping(part);
                if (seg.Length > 0) cleaned.Add(seg);
            }
            if (cleaned.Count == 0) return QuoteName(tableName ?? "", dialect);
            if (dialect == Dialect.Sqlite && cleaned.Count == 2 && cleaned[0].Equals("dbo", StringComparison.OrdinalIgnoreCase))
            {
                cleaned.RemoveAt(0);
            }
            return string.Join(".", cleaned.ConvertAll(p => QuoteName(p, dialect)));
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

        public static string ToSnakeCase(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new System.Text.StringBuilder(s.Length + 4);
            for (int i = 0; i < s.Length; i++)
            {
                var ch = s[i];
                if (ch >= 'A' && ch <= 'Z')
                {
                    if (i > 0)
                    {
                        var prev = s[i - 1];
                        var hasNextLower = i + 1 < s.Length && s[i + 1] >= 'a' && s[i + 1] <= 'z';
                        var prevIsUpper = prev >= 'A' && prev <= 'Z';
                        if (prev != '_' && (!prevIsUpper || hasNextLower))
                            sb.Append('_');
                    }
                    sb.Append(char.ToLowerInvariant(ch));
                }
                else
                {
                    sb.Append(ch);
                }
            }
            return sb.ToString();
        }

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
                        _relationMap[kv.Key] = kv.Value != null
                            ? new Dictionary<string, RelationDef>(kv.Value)
                            : new Dictionary<string, RelationDef>();
                    }
                }
            }
        }

        public static Dictionary<string, string> GetModelToTable()
        {
            lock (_lock) return new Dictionary<string, string>(_modelToTable);
        }

        public static bool TryResolveTable(string modelName, out string tableName)
        {
            tableName = null;
            if (string.IsNullOrEmpty(modelName)) return false;
            lock (_lock)
            {
                if (_modelToTable.TryGetValue(modelName, out var exact))
                {
                    tableName = exact;
                    return true;
                }
                foreach (var kv in _modelToTable)
                {
                    if (string.Equals(kv.Key, modelName, StringComparison.OrdinalIgnoreCase))
                    {
                        tableName = kv.Value;
                        return true;
                    }
                }
            }
            return false;
        }

        public static string ResolveTable(string modelName)
        {
            return TryResolveTable(modelName, out var resolved) ? resolved : (modelName ?? "");
        }

        public static object GetFieldsForModel(string modelName)
        {
            if (string.IsNullOrEmpty(modelName)) return null;
            lock (_lock)
            {
                if (_modelFields.TryGetValue(modelName, out var exact)) return exact;
                foreach (var kv in _modelFields)
                {
                    if (string.Equals(kv.Key, modelName, StringComparison.OrdinalIgnoreCase))
                        return kv.Value;
                }
                return null;
            }
        }

        public static bool ModelHasFields(string modelName)
        {
            var fields = GetFieldsForModel(modelName);
            switch (fields)
            {
                case System.Collections.IDictionary dict:
                    return dict.Count > 0;
                case IEnumerable<string> names:
                    foreach (var _ in names) return true;
                    return false;
                case System.Collections.IEnumerable seq:
                    foreach (var _ in seq) return true;
                    return false;
                default:
                    return false;
            }
        }

        public static bool ModelHasField(string modelName, string col)
        {
            if (string.IsNullOrEmpty(modelName) || string.IsNullOrEmpty(col)) return false;
            var fields = GetFieldsForModel(modelName);
            if (fields == null) return false;
            var targetSnake = ToSnakeCase(col);
            bool MatchesName(string candidate) =>
                !string.IsNullOrEmpty(candidate)
                && (string.Equals(candidate, col, StringComparison.Ordinal)
                    || string.Equals(candidate, col, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(ToSnakeCase(candidate), targetSnake, StringComparison.Ordinal));

            switch (fields)
            {
                case IDictionary<string, bool> boolDict:
                    foreach (var kv in boolDict)
                        if (kv.Value && MatchesName(kv.Key)) return true;
                    return false;
                case System.Collections.IDictionary dict:
                    foreach (System.Collections.DictionaryEntry entry in dict)
                        if (entry.Key is string keyStr && MatchesName(keyStr)) return true;
                    return false;
                case System.Collections.IEnumerable seq when !(fields is string):
                    foreach (var item in seq)
                    {
                        if (item is string str && MatchesName(str)) return true;
                        if (item is System.Collections.IDictionary itemDict && itemDict.Contains("name") && itemDict["name"] is string n && MatchesName(n))
                            return true;
                    }
                    return false;
                default:
                    return false;
            }
        }

        public static Dictionary<string, RelationDef> GetRelationsForModel(string modelName)
        {
            if (string.IsNullOrEmpty(modelName)) return new Dictionary<string, RelationDef>();
            lock (_lock)
            {
                if (_relationMap.TryGetValue(modelName, out var r))
                    return new Dictionary<string, RelationDef>(r);
                foreach (var kv in _relationMap)
                {
                    if (string.Equals(kv.Key, modelName, StringComparison.OrdinalIgnoreCase))
                        return new Dictionary<string, RelationDef>(kv.Value);
                }
                return new Dictionary<string, RelationDef>();
            }
        }

        public static bool ResolveRelationForModel(string modelName, string key, out string canonicalName, out RelationDef relation)
        {
            canonicalName = null;
            relation = null;
            if (string.IsNullOrEmpty(modelName) || string.IsNullOrEmpty(key)) return false;
            var rels = GetRelationsForModel(modelName);
            if (rels.Count == 0) return false;
            if (rels.TryGetValue(key, out var exact))
            {
                canonicalName = key;
                relation = exact;
                return true;
            }
            var names = new List<string>(rels.Keys);
            names.Sort(StringComparer.Ordinal);
            foreach (var relName in names)
            {
                if (string.Equals(relName, key, StringComparison.OrdinalIgnoreCase))
                {
                    canonicalName = relName;
                    relation = rels[relName];
                    return true;
                }
            }
            var targetSnake = ToSnakeCase(key);
            foreach (var relName in names)
            {
                if (string.Equals(ToSnakeCase(relName), targetSnake, StringComparison.Ordinal))
                {
                    canonicalName = relName;
                    relation = rels[relName];
                    return true;
                }
            }
            return false;
        }

        public static (string ChildCol, string ParentCol) ResolveRelationKeys(string parentModel, RelationDef rel)
        {
            if (rel == null) return ("id", "id");
            var rawFK = string.IsNullOrEmpty(rel.ForeignKey) ? "id" : rel.ForeignKey;
            var rawLK = string.IsNullOrEmpty(rel.LocalKey) ? "id" : rel.LocalKey;
            if (rel.RelationType == "many") return (rawFK, rawLK);

            if ((ModelHasField(rel.ModelName, rawFK) && !ModelHasField(rel.ModelName, rawLK))
                || (ModelHasField(parentModel, rawLK) && !ModelHasField(parentModel, rawFK)))
            {
                return (rawFK, rawLK);
            }
            return (rawLK, rawFK);
        }
    }

    // ─── Where / OrderBy builder ───────────────────────────────────────────────
    // Mirrors the TypeScript parseWhere/buildOrderBy used by the reference adapter.

    internal static class SqlBuilder
    {
        private static readonly string[] OperatorKeys =
        { "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt", "mode" };

        private static readonly HashSet<string> OperatorKeySet = new(OperatorKeys, StringComparer.Ordinal);

        private static readonly HashSet<string> RelationOperatorKeys = new(StringComparer.Ordinal)
        { "some", "none", "every", "is", "isNot", "is_not" };

        private static bool IsOperatorValue(object value)
        {
            if (!(value is Dictionary<string, object> dict)) return false;
            foreach (var op in OperatorKeys)
                if (dict.ContainsKey(op)) return true;
            return false;
        }

        private static bool IsRelationOperatorValue(object value)
        {
            if (!(value is Dictionary<string, object> dict)) return false;
            foreach (var key in dict.Keys)
                if (RelationOperatorKeys.Contains(key)) return true;
            return false;
        }

        private static List<string> SortedKeys(Dictionary<string, object> dict)
        {
            var keys = new List<string>(dict.Keys);
            keys.Sort(StringComparer.Ordinal);
            return keys;
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

        private static string ParseRelationFilter(string modelName, string relKey, RelationDef relation, object rawValue, Dictionary<string, object> parameters, Dialect dialect, string prefix, string selfRef)
        {
            if (relation == null) return null;
            if (!(rawValue is Dictionary<string, object> rawMap))
                throw new ArgumentException($"Relation filter for '{relKey}' on '{modelName}' must be a Dictionary<string, object>.");

            var isMany = relation.RelationType == "many";
            var normalized = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var k in SortedKeys(rawMap))
            {
                var canonical = k == "is_not" ? "isNot" : k;
                var allowed = isMany
                    ? (canonical == "some" || canonical == "none" || canonical == "every")
                    : (canonical == "is" || canonical == "isNot");
                if (!allowed)
                    throw new ArgumentException($"Unsupported relation filter operator '{k}' for relation '{relKey}' on '{modelName}'.");
                normalized[canonical] = rawMap[k];
            }

            if (normalized.Count == 0) return null;

            var childTable = SqlQuote.QuoteTable(An5Metadata.ResolveTable(relation.ModelName), dialect);
            var (childKey, parentKey) = An5Metadata.ResolveRelationKeys(modelName, relation);
            var childCol = SqlQuote.QuoteName(childKey, dialect);
            var parentCol = SqlQuote.QuoteName(parentKey, dialect);
            var parentRef = !string.IsNullOrEmpty(selfRef)
                ? $"{selfRef}."
                : $"{SqlQuote.QuoteTable(An5Metadata.ResolveTable(modelName), dialect)}.";

            static string BuildExists(string table, string alias, string correlation, string innerWhere)
            {
                var inner = !string.IsNullOrEmpty(innerWhere) ? $" AND ({innerWhere})" : "";
                return $"EXISTS (SELECT 1 FROM {table} AS {alias} WHERE {correlation}{inner})";
            }

            var parts = new List<string>();
            if (isMany)
            {
                foreach (var op in new[] { "some", "none", "every" })
                {
                    if (!normalized.TryGetValue(op, out var opVal)) continue;
                    if (!(opVal is Dictionary<string, object> innerDict))
                        throw new ArgumentException($"'{op}' filter on relation '{relKey}' must be a filter dictionary.");
                    var childAlias = "r_" + SanitizeParamName($"{prefix}{op}");
                    var correlation = $"{childAlias}.{childCol} = {parentRef}{parentCol}";
                    var inner = ParseWhere(innerDict, parameters, dialect, $"{prefix}{op}_", relation.ModelName, childAlias, $"{childAlias}.");
                    if (op == "some")
                    {
                        parts.Add(BuildExists(childTable, childAlias, correlation, inner));
                    }
                    else if (op == "none")
                    {
                        parts.Add("NOT " + BuildExists(childTable, childAlias, correlation, inner));
                    }
                    else
                    {
                        var violatedWhere = !string.IsNullOrEmpty(inner) ? $" AND NOT ({inner})" : " AND 1=0";
                        parts.Add($"NOT EXISTS (SELECT 1 FROM {childTable} AS {childAlias} WHERE {correlation}{violatedWhere})");
                    }
                }
            }
            else
            {
                foreach (var op in new[] { "is", "isNot" })
                {
                    if (!normalized.TryGetValue(op, out var opVal)) continue;
                    var childAlias = "r_" + SanitizeParamName($"{prefix}{op}");
                    var correlation = $"{childAlias}.{childCol} = {parentRef}{parentCol}";
                    if (opVal == null)
                    {
                        parts.Add(op == "is"
                            ? "NOT " + BuildExists(childTable, childAlias, correlation, "")
                            : BuildExists(childTable, childAlias, correlation, ""));
                        continue;
                    }
                    if (!(opVal is Dictionary<string, object> innerDict))
                        throw new ArgumentException($"'{op}' filter on relation '{relKey}' must be a filter dictionary or null.");
                    var inner = ParseWhere(innerDict, parameters, dialect, $"{prefix}{op}_", relation.ModelName, childAlias, $"{childAlias}.");
                    parts.Add(op == "is"
                        ? BuildExists(childTable, childAlias, correlation, inner)
                        : "NOT " + BuildExists(childTable, childAlias, correlation, inner));
                }
            }

            return parts.Count > 0 ? string.Join(" AND ", parts) : null;
        }

        private static readonly Dictionary<string, string> AggregateHavingOps = new(StringComparer.Ordinal)
        {
            { "_count", "COUNT" },
            { "_sum", "SUM" },
            { "_avg", "AVG" },
            { "_min", "MIN" },
            { "_max", "MAX" },
        };

        private static bool IsNonScalarCollection(object value)
        {
            if (value == null || value is string || value is byte[]) return false;
            return value is System.Collections.IEnumerable;
        }

        private static List<string> BuildFieldConditions(string col, string key, object value, Dictionary<string, object> parameters, Dialect dialect, string prefix, string modelName, string selfRef, string colPrefix)
        {
            return BuildExprConditions(col, key, value, parameters, dialect, prefix);
        }

        private static List<string> BuildExprConditions(string expr, string label, object value, Dictionary<string, object> parameters, Dialect dialect, string prefix, bool inheritedInsensitive = false)
        {
            if (value == null)
                return new List<string> { $"{expr} IS NULL" };

            var baseName = SanitizeParamName($"{prefix}{label}");
            if (!(value is Dictionary<string, object> opMap))
            {
                if (IsNonScalarCollection(value))
                    throw new ArgumentException($"Filter value for '{label}' must be a scalar value, not a collection.");
                parameters[baseName] = value;
                return new List<string> { $"{expr} = {Placeholder(baseName)}" };
            }

            var insensitive = inheritedInsensitive;
            if (opMap.TryGetValue("mode", out var modeVal))
            {
                if (!(modeVal is string modeStr) || (modeStr != "default" && modeStr != "insensitive"))
                    throw new ArgumentException($"Invalid filter mode '{modeVal}' for field '{label}'.");
                insensitive = modeStr == "insensitive";
            }

            var conditions = new List<string>();
            foreach (var op in SortedKeys(opMap))
            {
                if (!OperatorKeySet.Contains(op))
                    throw new ArgumentException($"Unsupported filter operator '{op}' for field '{label}'.");
                if (op == "mode") continue;

                var opVal = opMap[op];
                switch (op)
                {
                    case "not":
                        if (opVal == null)
                        {
                            conditions.Add($"{expr} IS NOT NULL");
                        }
                        else if (opVal is Dictionary<string, object> nested)
                        {
                            var nestedConds = BuildExprConditions(expr, label, nested, parameters, dialect, $"{prefix}{SanitizeParamName(label)}_not_", insensitive);
                            if (nestedConds.Count > 0)
                                conditions.Add("NOT (" + string.Join(" AND ", nestedConds) + ")");
                        }
                        else if (IsNonScalarCollection(opVal))
                        {
                            throw new ArgumentException($"'not' operator on '{label}' requires a scalar value or operator dictionary.");
                        }
                        else if (insensitive && opVal is string sNot)
                        {
                            parameters[baseName + "_not"] = sNot;
                            conditions.Add($"LOWER({expr}) <> LOWER({Placeholder(baseName + "_not")})");
                        }
                        else
                        {
                            parameters[baseName + "_not"] = opVal;
                            conditions.Add($"{expr} <> {Placeholder(baseName + "_not")}");
                        }
                        break;
                    case "equals":
                        if (opVal == null)
                        {
                            conditions.Add($"{expr} IS NULL");
                        }
                        else if (opVal is System.Collections.IDictionary || IsNonScalarCollection(opVal))
                        {
                            throw new ArgumentException($"'equals' operator on '{label}' requires a scalar value.");
                        }
                        else if (insensitive && opVal is string sEq)
                        {
                            parameters[baseName + "_eq"] = sEq;
                            conditions.Add($"LOWER({expr}) = LOWER({Placeholder(baseName + "_eq")})");
                        }
                        else
                        {
                            parameters[baseName + "_eq"] = opVal;
                            conditions.Add($"{expr} = {Placeholder(baseName + "_eq")}");
                        }
                        break;
                    case "contains":
                        if (!(opVal is string sContains))
                            throw new ArgumentException($"'contains' operator on field '{label}' requires a string value.");
                        parameters[baseName + "_co"] = "%" + sContains + "%";
                        conditions.Add(insensitive
                            ? $"LOWER({expr}) LIKE LOWER({Placeholder(baseName + "_co")})"
                            : $"{expr} LIKE {Placeholder(baseName + "_co")}");
                        break;
                    case "startsWith":
                        if (!(opVal is string sStarts))
                            throw new ArgumentException($"'startsWith' operator on field '{label}' requires a string value.");
                        parameters[baseName + "_sw"] = sStarts + "%";
                        conditions.Add(insensitive
                            ? $"LOWER({expr}) LIKE LOWER({Placeholder(baseName + "_sw")})"
                            : $"{expr} LIKE {Placeholder(baseName + "_sw")}");
                        break;
                    case "endsWith":
                        if (!(opVal is string sEnds))
                            throw new ArgumentException($"'endsWith' operator on field '{label}' requires a string value.");
                        parameters[baseName + "_ew"] = "%" + sEnds;
                        conditions.Add(insensitive
                            ? $"LOWER({expr}) LIKE LOWER({Placeholder(baseName + "_ew")})"
                            : $"{expr} LIKE {Placeholder(baseName + "_ew")}");
                        break;
                    case "gte":
                    case "lte":
                    case "gt":
                    case "lt":
                    {
                        if (opVal == null || opVal is System.Collections.IDictionary || IsNonScalarCollection(opVal))
                            throw new ArgumentException($"'{op}' operator on '{label}' requires a scalar value.");
                        var sqlOp = op == "gte" ? ">=" : op == "lte" ? "<=" : op == "gt" ? ">" : "<";
                        parameters[baseName + "_" + op] = opVal;
                        conditions.Add($"{expr} {sqlOp} {Placeholder(baseName + "_" + op)}");
                        break;
                    }
                    case "in":
                    case "notIn":
                    {
                        if (opVal == null || opVal is string || opVal is byte[] || opVal is System.Collections.IDictionary || !(opVal is System.Collections.IEnumerable seq))
                            throw new ArgumentException($"'{op}' operator on field '{label}' requires a collection.");
                        var items = new List<object>();
                        var allStrings = true;
                        foreach (var v in seq)
                        {
                            if (!(v is string)) allStrings = false;
                            items.Add(v);
                        }
                        if (items.Count == 0)
                        {
                            conditions.Add(op == "in" ? "1=0" : "1=1");
                            break;
                        }
                        var useLower = insensitive && allStrings;
                        var phs = new List<string>(items.Count);
                        for (var idx = 0; idx < items.Count; idx++)
                        {
                            var pn = op == "in" ? $"{baseName}_in{idx}" : $"{baseName}_notin{idx}";
                            parameters[pn] = items[idx];
                            var ph = Placeholder(pn);
                            phs.Add(useLower ? $"LOWER({ph})" : ph);
                        }
                        var lhs = useLower ? $"LOWER({expr})" : expr;
                        conditions.Add(op == "in"
                            ? $"{lhs} IN ({string.Join(", ", phs)})"
                            : $"{lhs} NOT IN ({string.Join(", ", phs)})");
                        break;
                    }
                }
            }
            return conditions;
        }

        private static string BuildLogicalCondition(
            string key,
            object value,
            string prefix,
            Func<Dictionary<string, object>, string, string> recurse)
        {
            if (value == null)
                throw new ArgumentException($"'{key}' filter payload must not be null.");
            System.Collections.IList list;
            if (key == "OR")
            {
                if (!(value is System.Collections.IList orSeq))
                    throw new ArgumentException("'OR' filter must be a list of dictionaries.");
                list = orSeq;
            }
            else if (value is Dictionary<string, object> singleMap)
            {
                list = new object[] { singleMap };
            }
            else if (value is System.Collections.IList seq)
            {
                list = seq;
            }
            else
            {
                throw new ArgumentException($"'{key}' filter must be a dictionary or list of dictionaries.");
            }

            var subs = new List<string>();
            var i = 0;
            foreach (var item in list)
            {
                if (!(item is Dictionary<string, object> subMap))
                    throw new ArgumentException($"'{key}' filter entry must be a Dictionary<string, object>.");
                var s = recurse(subMap, $"{prefix}{key}{i++}_");
                subs.Add(string.IsNullOrEmpty(s) ? "1=1" : s);
            }
            if (subs.Count == 0)
                return key == "OR" ? "1=0" : "";

            var joiner = key == "AND" ? " AND " : " OR ";
            var negation = key == "NOT" ? "NOT " : "";
            return negation + "(" + string.Join(joiner, subs) + ")";
        }

        public static string BuildHaving(
            object having,
            Dictionary<string, object> parameters,
            Dialect dialect,
            List<string> byFields,
            string prefix = "h_",
            string modelName = null)
        {
            if (having == null) return "";
            if (!(having is Dictionary<string, object> dict))
                throw new ArgumentException("HAVING clause must be a Dictionary<string, object>.");
            if (dict.Count == 0) return "";

            var bySet = new HashSet<string>(byFields ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
            var conditions = new List<string>();
            foreach (var key in SortedKeys(dict))
            {
                var value = dict[key];
                if (key == "OR" || key == "AND" || key == "NOT")
                {
                    var logical = BuildLogicalCondition(key, value, prefix, (sub, nextPrefix) =>
                        BuildHaving(sub, parameters, dialect, byFields, nextPrefix, modelName));
                    if (!string.IsNullOrEmpty(logical))
                        conditions.Add(logical);
                    continue;
                }

                if (AggregateHavingOps.TryGetValue(key, out var sqlFn))
                {
                    if (!(value is Dictionary<string, object> aggMap))
                        throw new ArgumentException($"'{key}' having filter must be a Dictionary<string, object>.");
                    foreach (var field in SortedKeys(aggMap))
                    {
                        string expr;
                        if (field == "_all")
                        {
                            if (key != "_count")
                                throw new ArgumentException($"'_all' is only valid inside '_count' having filter, not '{key}'.");
                            expr = "COUNT(*)";
                        }
                        else
                        {
                            if (!string.IsNullOrEmpty(modelName) && An5Metadata.ModelHasFields(modelName) && !An5Metadata.ModelHasField(modelName, field))
                                throw new ArgumentException($"Unknown field '{field}' on model '{modelName}' in '{key}' having filter.");
                            expr = $"{sqlFn}({SqlQuote.QuoteName(field, dialect)})";
                        }
                        conditions.AddRange(BuildExprConditions(expr, $"{key}_{field}", aggMap[field], parameters, dialect, prefix));
                    }
                    continue;
                }

                if (!string.IsNullOrEmpty(modelName) && An5Metadata.ModelHasFields(modelName) && !An5Metadata.ModelHasField(modelName, key))
                    throw new ArgumentException($"Unknown field '{key}' on model '{modelName}' in having clause.");
                if (!bySet.Contains(key))
                    throw new ArgumentException($"Field '{key}' in having clause must be included in 'by' fields or wrapped in an aggregate filter (_count, _sum, _avg, _min, _max).");

                conditions.AddRange(BuildExprConditions(SqlQuote.QuoteName(key, dialect), key, value, parameters, dialect, prefix));
            }
            return string.Join(" AND ", conditions);
        }

        public static string ParseWhere(object where, Dictionary<string, object> parameters, Dialect dialect, string prefix = "", string modelName = null, string selfRef = "", string colPrefix = "")
        {
            if (where == null) return "";
            if (!(where is Dictionary<string, object> dict))
                throw new ArgumentException("WHERE clause must be a Dictionary<string, object>.");
            if (dict.Count == 0) return "";

            var clean = new Dictionary<string, object>();
            foreach (var key in SortedKeys(dict))
            {
                var val = dict[key];
                if (key == "AND" || key == "OR" || key == "NOT" || !key.Contains("_"))
                {
                    clean[key] = val;
                    continue;
                }
                if (!string.IsNullOrEmpty(modelName)
                    && (An5Metadata.ResolveRelationForModel(modelName, key, out _, out _) || An5Metadata.ModelHasField(modelName, key)))
                {
                    clean[key] = val;
                    continue;
                }
                if (val is Dictionary<string, object> inner && !IsOperatorValue(inner) && !IsRelationOperatorValue(inner))
                {
                    foreach (var subKey in SortedKeys(inner)) clean[subKey] = inner[subKey];
                }
                else
                {
                    clean[key] = val;
                }
            }

            var conditions = new List<string>();
            foreach (var key in SortedKeys(clean))
            {
                var value = clean[key];
                if (key == "OR" || key == "AND" || key == "NOT")
                {
                    var logical = BuildLogicalCondition(key, value, prefix, (sub, nextPrefix) =>
                        ParseWhere(sub, parameters, dialect, nextPrefix, modelName, selfRef, colPrefix));
                    if (!string.IsNullOrEmpty(logical))
                        conditions.Add(logical);
                    continue;
                }

                if (!string.IsNullOrEmpty(modelName))
                {
                    if (An5Metadata.ResolveRelationForModel(modelName, key, out _, out var relation))
                    {
                        var relSql = ParseRelationFilter(modelName, key, relation, value, parameters, dialect, $"{prefix}{key}_", selfRef);
                        if (!string.IsNullOrEmpty(relSql))
                            conditions.Add(relSql);
                        continue;
                    }
                    if (An5Metadata.ModelHasFields(modelName) && !An5Metadata.ModelHasField(modelName, key))
                        throw new ArgumentException($"Unknown field '{key}' on model '{modelName}'.");
                }

                var col = $"{colPrefix}{SqlQuote.QuoteName(key, dialect)}";
                conditions.AddRange(BuildFieldConditions(col, key, value, parameters, dialect, prefix, modelName, selfRef, colPrefix));
            }
            return string.Join(" AND ", conditions);
        }
    }
}
