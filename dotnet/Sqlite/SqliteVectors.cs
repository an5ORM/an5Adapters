using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace An5Orm
{
    // ─── SQLite vector search ────────────────────────────────────────────────────
    //
    // SQLite has no vector type, so a `VECTOR(n)` column stores a BLOB of
    // little-endian float32 values (see `EncodeVector`) and is ranked in one of
    // four ways, in this order:
    //
    //   1. sqlite-vec  native scalar distances, when the extension loads.
    //   2. udf         an5_vec_cosine / an5_vec_l2 / an5_vec_ip registered with
    //                  the connection. Reads the BLOB and the legacy JSON text.
    //   3. sql         json_each brute force in plain SQL. Needs no user
    //                  function, but only reaches rows stored as JSON text.
    //   4. memory      the column is loaded and scored in C#.
    //
    // Strategies 1-3 rank inside the database and transfer only the matching
    // rows, which is why they are preferred over the in-memory path.

    public static class SqliteVectors
    {
        /// <summary>Scalar functions the adapter registers itself.</summary>
        public static readonly Dictionary<string, string> An5Functions = new()
        {
            ["cosine"] = "an5_vec_cosine",
            ["euclidean"] = "an5_vec_l2",
            ["dot"] = "an5_vec_ip",
        };

        /// <summary>Scalar functions shipped by the sqlite-vec extension.</summary>
        public static readonly Dictionary<string, string> SqliteVecFunctions = new()
        {
            ["cosine"] = "vec_distance_cosine",
            ["euclidean"] = "vec_distance_l2",
            ["dot"] = "vec_distance_ip",
        };

        public const string StrategySqliteVec = "sqlite-vec";
        public const string StrategyUdf = "udf";
        public const string StrategySql = "sql";
        public const string StrategyMemory = "memory";

        private const int BytesPerFloat = 4;

        public static string NormalizeMetric(string metric)
            => metric == "euclidean" || metric == "dot" ? metric : "cosine";

        // ── Codec ───────────────────────────────────────────────────────────────

        /// <summary>
        /// Reads a numeric array out of the shapes a driver can hand back: a
        /// list, a JSON text column, or raw float32 bytes.
        /// </summary>
        public static List<double> ParseVector(object value)
        {
            switch (value)
            {
                case null:
                    return null;
                case List<double> list:
                    return list.Count > 0 ? list : null;
                case double[] array:
                    return array.Length > 0 ? array.ToList() : null;
                case float[] floats:
                    return floats.Length > 0 ? floats.Select(f => (double)f).ToList() : null;
                case byte[] bytes:
                    return DecodeVector(bytes);
                case string text:
                    var trimmed = text.Trim();
                    if (!trimmed.StartsWith("[")) return null;
                    try { return ParseVector(JsonSerializer.Deserialize<double[]>(trimmed)); }
                    catch { return null; }
                case System.Collections.IEnumerable seq when value is not string:
                    try { return ParseVector(seq.Cast<object>().Select(o => Convert.ToDouble(o)).ToList()); }
                    catch { return null; }
                default:
                    return null;
            }
        }

        /// <summary>
        /// Decodes a stored vector: a float32 BLOB, a legacy JSON text column,
        /// or an array the caller already decoded.
        /// </summary>
        public static List<double> DecodeVector(object value)
        {
            var direct = value is byte[] ? null : ParseVector(value);
            if (direct != null) return direct;
            if (!(value is byte[] bytes) || bytes.Length == 0 || bytes.Length % BytesPerFloat != 0) return null;
            var outVec = new List<double>(bytes.Length / BytesPerFloat);
            for (int i = 0; i < bytes.Length; i += BytesPerFloat)
                outVec.Add(BitConverter.ToSingle(bytes, i));
            return outVec;
        }

        /// <summary>Encodes a vector as the little-endian float32 BLOB the column stores.</summary>
        public static byte[] EncodeVector(IReadOnlyList<double> values)
        {
            var bytes = new byte[values.Count * BytesPerFloat];
            for (int i = 0; i < values.Count; i++)
            {
                // Little-endian, written through the integer view of the float:
                // SQLite reads the bytes in memory order.
                var bits = BitConverter.SingleToInt32Bits((float)values[i]);
                bytes[i * BytesPerFloat] = (byte)(bits & 0xFF);
                bytes[i * BytesPerFloat + 1] = (byte)((bits >> 8) & 0xFF);
                bytes[i * BytesPerFloat + 2] = (byte)((bits >> 16) & 0xFF);
                bytes[i * BytesPerFloat + 3] = (byte)((bits >> 24) & 0xFF);
            }
            return bytes;
        }

        /// <summary>True when the value still has to become bytes on its way into a column.</summary>
        public static bool NeedsVectorEncoding(object value)
        {
            if (value == null || value is string || value is byte[]) return false;
            if (value is System.Collections.IEnumerable seq) return !(value is System.Collections.IDictionary);
            return false;
        }

        /// <summary>True when generated metadata describes a `VECTOR(n)` column.</summary>
        public static bool IsVectorField(object definition)
        {
            if (definition == null) return false;
            if (definition is string text)
                return text.Contains("[]") || text.TrimStart().StartsWith("VECTOR", StringComparison.OrdinalIgnoreCase);

            // The metadata carries a small record per field.
            var kind = ReadMember(definition, "kind") as string;
            if (kind == "vector") return true;
            var sql = ReadMember(definition, "sql") as string ?? ReadMember(definition, "type") as string;
            if (!string.IsNullOrWhiteSpace(sql))
            {
                var trimmed = sql.Trim();
                if (trimmed.StartsWith("VECTOR", StringComparison.OrdinalIgnoreCase)
                    && (trimmed.Length == 6 || trimmed[6] == '(' || trimmed[6] == ' '))
                    return true;
            }
            var ts = ReadMember(definition, "ts") as string;
            return ts != null && ts.Contains("[]");
        }

        private static object ReadMember(object target, string name)
        {
            if (target is System.Collections.IDictionary dict)
                return dict.Contains(name) ? dict[name] : null;
            var prop = target.GetType().GetProperty(name);
            return prop != null ? prop.GetValue(target) : null;
        }

        // ── Distance ────────────────────────────────────────────────────────────

        /// <summary>
        /// Distance between two equal-length vectors, lower is closer. Mirrors
        /// the SQL functions so a search ranks the same way whichever strategy ran.
        /// </summary>
        public static double? VectorDistance(IReadOnlyList<double> a, IReadOnlyList<double> b, string metric)
        {
            if (a == null || b == null || a.Count == 0 || a.Count != b.Count) return null;
            var resolved = NormalizeMetric(metric);
            if (resolved == "euclidean")
            {
                double sum = 0;
                for (int i = 0; i < a.Count; i++)
                {
                    var diff = a[i] - b[i];
                    sum += diff * diff;
                }
                return Math.Sqrt(sum);
            }
            double dot = 0, m1 = 0, m2 = 0;
            for (int i = 0; i < a.Count; i++)
            {
                dot += a[i] * b[i];
                m1 += a[i] * a[i];
                m2 += b[i] * b[i];
            }
            if (resolved == "dot") return -dot;
            return m1 > 0 && m2 > 0 ? 1.0 - dot / (Math.Sqrt(m1) * Math.Sqrt(m2)) : 1.0;
        }

        /// <summary>The scalar function registered with the driver for one metric.</summary>
        public static Func<object[], object> MakeDistanceFunction(string metric)
            => args =>
            {
                var a = DecodeVector(args.Length > 0 ? args[0] : null);
                var b = DecodeVector(args.Length > 1 ? args[1] : null);
                if (a == null || b == null) return DBNull.Value;
                var distance = VectorDistance(a, b, metric);
                return distance.HasValue ? (object)distance.Value : DBNull.Value;
            };

        // ── Query building ──────────────────────────────────────────────────────

        /// <summary>`json_valid` fails on a float32 BLOB, so the JSON path needs this guard.</summary>
        private static string JsonText(string column)
            => $"CASE WHEN json_valid({column}) THEN {column} ELSE '[]' END";

        private static string JsonDistanceExpr(string metric, string column)
        {
            var row = JsonText(column);
            var sameLength = $"(SELECT COUNT(*) FROM json_each({row})) = (SELECT COUNT(*) FROM q)";
            string terms;
            switch (metric)
            {
                case "euclidean":
                    terms = $"sqrt((SELECT SUM((je.value - q.v) * (je.value - q.v)) FROM json_each({row}) je JOIN q ON q.k = je.key))";
                    break;
                case "dot":
                    terms = $"-(SELECT SUM(je.value * q.v) FROM json_each({row}) je JOIN q ON q.k = je.key)";
                    break;
                default:
                    terms = $"1.0 - (SELECT SUM(je.value * q.v) FROM json_each({row}) je JOIN q ON q.k = je.key)"
                          + $" / NULLIF(sqrt((SELECT SUM(q.v * q.v) FROM q)) * sqrt((SELECT SUM(je.value * je.value) FROM json_each({row}) je)), 0)";
                    break;
            }
            return $"CASE WHEN {sameLength} THEN {terms} END";
        }

        /// <summary>
        /// Ranking SQL for one strategy, with the parameters it needs appended to
        /// `parameters`. `sqlite-vec` and `udf` bind the query vector as a float32
        /// BLOB; `sql` binds it as JSON text because `json_each` reads text.
        /// </summary>
        public static string BuildQuery(
            string strategy, string metric, string table, string column,
            IReadOnlyList<double> vector, int take, string tail,
            Dictionary<string, object> parameters)
        {
            metric = NormalizeMetric(metric);
            // A row whose stored vector cannot be scored (a NULL, a text column,
            // another dimension) yields a NULL distance; those rows are dropped
            // rather than reported, so a caller never has to sort them out.
            string Rank(string inner)
                => $"SELECT * FROM ({inner}) AS an5_ranked WHERE distance IS NOT NULL ORDER BY distance ASC LIMIT {take}";

            if (strategy == StrategySqliteVec)
            {
                parameters["an5_vector"] = EncodeVector(vector);
                parameters["an5_vector_bytes"] = vector.Count * BytesPerFloat;
                // sqlite-vec only understands float32 BLOB operands, so rows stored
                // any other way are excluded instead of aborting the query.
                return Rank($"SELECT *, CASE WHEN vec_length(vec_f32({column})) = {vector.Count}"
                          + $" THEN {SqliteVecFunctions[metric]}(vec_f32({column}), @an5_vector) END AS distance FROM {table}"
                          + (string.IsNullOrWhiteSpace(tail) ? " WHERE " : tail + " AND ")
                          + $"{column} IS NOT NULL");
            }

            if (strategy == StrategyUdf)
            {
                parameters["an5_vector"] = EncodeVector(vector);
                return Rank($"SELECT *, {An5Functions[metric]}({column}, @an5_vector) AS distance FROM {table}{tail}");
            }

            parameters["an5_vector_json"] = JsonSerializer.Serialize(vector);
            return "WITH q AS (SELECT je.key AS k, CAST(je.value AS REAL) AS v FROM json_each(@an5_vector_json) je) "
                 + Rank($"SELECT *, {JsonDistanceExpr(metric, column)} AS distance FROM {table}{tail}");
        }

        // ── Capabilities ────────────────────────────────────────────────────────

        /// <summary>
        /// The ordered strategies to try. `declaredType` is the column's DDL type:
        /// the JSON strategy only reaches rows stored as text, so a `BLOB` column
        /// drops it from the order.
        /// </summary>
        public static List<string> PlanStrategies(
            bool hasVec, bool hasUdf, bool hasJson1, string declaredType, string preference)
        {
            if (!string.IsNullOrWhiteSpace(preference) && preference != "auto")
                return preference == StrategyMemory ? new List<string>() : new List<string> { preference };

            var available = new List<string>();
            if (hasVec) available.Add(StrategySqliteVec);
            if (hasUdf) available.Add(StrategyUdf);
            if (hasJson1) available.Add(StrategySql);

            var declared = (declaredType ?? "").ToUpperInvariant();
            if (declared.Length > 0
                && !new[] { "TEXT", "CHAR", "CLOB", "STRING", "JSON" }.Any(t => declared.Contains(t)))
            {
                // A BLOB column has no JSON to read, so json_each can only produce NULLs.
                available.Remove(StrategySql);
            }
            return available;
        }

        /// <summary>Reads a vector column's declared DDL type, or null when not found.</summary>
        public static string ReadColumnType(
            Func<string, Dictionary<string, object>, List<Dictionary<string, object>>> exec,
            string table, string column)
        {
            try
            {
                var rows = exec(
                    "SELECT type FROM pragma_table_info(@an5_table) WHERE name = @an5_column",
                    new Dictionary<string, object> { ["an5_table"] = table, ["an5_column"] = column });
                var value = rows.Count > 0 ? rows[0].GetValueOrDefault("type") : null;
                return value == null ? null : value.ToString();
            }
            catch { return null; }
        }

        /// <summary>
        /// Ranks a SQLite table inside the database. Returns null when the
        /// connection offers no strategy, so the caller can fall back to scoring
        /// in memory.
        /// </summary>
        public static List<Dictionary<string, object>> RunSearch(
            Func<string, Dictionary<string, object>, List<Dictionary<string, object>>> exec,
            string table, string rawTable, string column, string rawColumn,
            IReadOnlyList<double> vector, string metric, int take, string tail,
            Dictionary<string, object> parameters, SqliteVectorSupport support)
        {
            if (vector == null || vector.Count == 0) return null;

            var caps = support?.Capabilities() ?? new SqliteVectorCapabilities { Json1 = true };
            if (support != null) support.ProbeJson1(exec);

            var declaredType = ReadColumnType(exec, rawTable, rawColumn);
            foreach (var strategy in PlanStrategies(caps.Vec, caps.Udf, caps.Json1, declaredType, support?.Preference))
            {
                if (strategy == StrategySql) {
                    var binary = exec($"SELECT 1 FROM {table}" + (string.IsNullOrWhiteSpace(tail) ? " WHERE " : tail + " AND ")
                        + $"typeof({column}) = 'blob' LIMIT 1", parameters);
                    if (binary.Count > 0) continue;
                }
                var bound = new Dictionary<string, object>();
                foreach (var kv in parameters) bound[kv.Key] = kv.Value;
                var sql = BuildQuery(strategy, metric, table, column, vector, take, tail, bound);
                try
                {
                    var rows = exec(sql, bound);
                    if (rows != null) return rows;
                }
                catch
                {
                    // The connection advertised the capability but the query
                    // failed, e.g. an extension that did not really load. The
                    // next strategy is cheaper than reporting the failure.
                    continue;
                }
            }
            return null;
        }
    }

    /// <summary>What a SQLite connection can do, resolved once and cached.</summary>
    public class SqliteVectorCapabilities
    {
        /// <summary>`vec_version()` answered, so the sqlite-vec extension is loaded.</summary>
        public bool Vec { get; set; }
        /// <summary>The adapter's own distance functions are registered.</summary>
        public bool Udf { get; set; }
        /// <summary>`json_each()` is available, which the pure-SQL strategy needs.</summary>
        public bool Json1 { get; set; }
    }

    /// <summary>
    /// The settings one SQLite connection needs for in-database vector search.
    /// Filled in by the engine, which knows how to open connections.
    /// </summary>
    public class SqliteVectorSupport
    {
        /// <summary>Path to the sqlite-vec extension binary to load.</summary>
        public string SqliteVecPath { get; set; }
        /// <summary>Pin a strategy instead of probing for the fastest one available.</summary>
        public string Preference { get; set; }

        private SqliteVectorCapabilities _capabilities;

        public SqliteVectorCapabilities Capabilities()
            => _capabilities ??= new SqliteVectorCapabilities { Udf = true, Json1 = true };

        /// <summary>Confirms JSON1 before a query is built that needs it.</summary>
        public void ProbeJson1(Func<string, Dictionary<string, object>, List<Dictionary<string, object>>> exec)
        {
            var caps = Capabilities();
            if (caps.Json1) return;
            try
            {
                exec("SELECT json_valid('[1]') AS an5_json_ok", new Dictionary<string, object>());
                caps.Json1 = true;
            }
            catch { caps.Json1 = false; }
        }

        /// <summary>Records what the connection actually manages, after the engine tried.</summary>
        internal void Report(bool vec, bool udf, bool json1)
        {
            var caps = Capabilities();
            caps.Vec = vec;
            caps.Udf = udf;
            caps.Json1 = json1;
        }
    }
}
