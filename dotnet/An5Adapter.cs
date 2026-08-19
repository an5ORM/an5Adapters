// An5Adapter.cs
// Standalone .NET runtime adapter for AN5 ORM.

using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace An5Orm
{
// ─── Adapter ────────────────────────────────────────────────────────────────

    public class An5Adapter : IDisposable
    {
        public string ConnectionString { get; }
        public Dialect Dialect => _engine.Dialect;
        private readonly IQueryEngine _engine;
        private readonly int _commandTimeout;

        public An5Adapter(string connectionString, int commandTimeout = 60)
        {
            ConnectionString = connectionString ?? throw new ArgumentNullException(nameof(connectionString));
            _commandTimeout = commandTimeout;
            _engine = DialectDetector.Detect(connectionString) switch
            {
                Dialect.Postgres => new PostgresEngine(connectionString, commandTimeout),
                _ => new MssqlEngine(connectionString, commandTimeout)
            };
        }

        public An5Adapter(An5AdapterOptions options) : this(options.ConnectionString, options.CommandTimeout) { }

        // ── Raw query execution ────────────────────────────────────────────────

        public List<Dictionary<string, object>> QueryRaw(string sql, Dictionary<string, object> parameters = null)
            => _engine.QueryRaw(sql, parameters);

        public List<T> QueryRaw<T>(string sql, Dictionary<string, object> parameters = null) where T : new()
            => _engine.QueryRaw<T>(sql, parameters);

        public int ExecuteRaw(string sql, Dictionary<string, object> parameters = null)
            => _engine.ExecuteRaw(sql, parameters);

        // ── Stored Procedure Execution ────────────────────────────────────────

        public List<T> QueryProc<T>(string procName, Dictionary<string, object> parameters = null) where T : new()
        {
            var paramList = new List<string>();
            if (parameters != null)
            {
                foreach (var k in parameters.Keys)
                {
                    paramList.Add(Dialect == Dialect.Postgres ? "@" + k : "@" + k + " = @" + k);
                }
            }
            var sql = Dialect == Dialect.Postgres
                ? $"CALL {procName}({string.Join(", ", paramList)})"
                : (paramList.Count > 0 ? $"EXEC {procName} {string.Join(", ", paramList)}" : $"EXEC {procName}");
            return QueryRaw<T>(sql, parameters);
        }

        public int ExecuteProc(string procName, Dictionary<string, object> parameters = null)
        {
            var paramList = new List<string>();
            if (parameters != null)
            {
                foreach (var k in parameters.Keys)
                {
                    paramList.Add(Dialect == Dialect.Postgres ? "@" + k : "@" + k + " = @" + k);
                }
            }
            var sql = Dialect == Dialect.Postgres
                ? $"CALL {procName}({string.Join(", ", paramList)})"
                : (paramList.Count > 0 ? $"EXEC {procName} {string.Join(", ", paramList)}" : $"EXEC {procName}");
            return ExecuteRaw(sql, parameters);
        }

        // ── Transaction ────────────────────────────────────────────────────────

        public An5Transaction BeginTransaction()
        {
            return new An5Transaction(_engine.BeginTransaction());
        }

        public TResult Transaction<TResult>(Func<An5Adapter, TResult> fn)
        {
            using var txScope = _engine.BeginTransaction();
            try
            {
                var result = fn(this);
                txScope.Commit();
                return result;
            }
            catch
            {
                txScope.Rollback();
                throw;
            }
        }

        // ── Table & View client factory ────────────────────────────────────────

        public AdapterTableClient<T> Table<T>(string tableName) where T : new()
            => new AdapterTableClient<T>(this, tableName, _engine.Dialect);

        public ViewClient<T> View<T>(string viewName) where T : new()
            => new ViewClient<T>(this, viewName, _engine.Dialect);

        public ViewClient<T> View<T>(string viewName, string modelName) where T : new()
            => new ViewClient<T>(this, viewName, modelName, _engine.Dialect);

        public void Dispose() { }
    }

// ─── Adapter metadata injection ─────────────────────────────────────────────

    public static class An5AdapterMetadata
    {
        public static void Set(AdapterMetadata metadata)
            => An5Metadata.SetAdapterMetadata(metadata);

        public static Dictionary<string, string> GetModelToTable()
            => An5Metadata.GetModelToTable();

        public static Dictionary<string, RelationDef> GetRelationsForModel(string modelName)
            => An5Metadata.GetRelationsForModel(modelName);

        public static object GetFieldsForModel(string modelName)
            => An5Metadata.GetFieldsForModel(modelName);
    }

// ─── Transaction wrapper ───────────────────────────────────────────────────

    public class An5Transaction : IDisposable
    {
        private readonly An5TransactionBase _inner;

        internal An5Transaction(An5TransactionBase inner) => _inner = inner;

        public void Commit() => _inner.Commit();
        public void Rollback() => _inner.Rollback();
        public void Dispose() => _inner.Dispose();
    }

// ─── Read-Only View Client ──────────────────────────────────────────────────

    public class ViewClient<T> where T : new()
    {
        private readonly AdapterTableClient<T> _tableClient;
        public string ViewName { get; }

        public ViewClient(An5Adapter adapter, string viewName, Dialect dialect)
        {
            ViewName = viewName;
            _tableClient = new AdapterTableClient<T>(adapter, viewName, dialect);
        }

        public ViewClient(An5Adapter adapter, string viewName, string modelName, Dialect dialect)
        {
            ViewName = viewName;
            _tableClient = new AdapterTableClient<T>(adapter, viewName, modelName, dialect);
        }

        public List<T> FindMany(string whereClause = null, Dictionary<string, object> parameters = null, string orderBy = null, int? skip = null, int? take = null)
            => _tableClient.FindMany(whereClause, parameters, orderBy, skip, take);

        public List<T> FindMany(FindManyArgs args)
            => _tableClient.FindMany(args);

        public T FindFirst(string whereClause = null, Dictionary<string, object> parameters = null, string orderBy = null)
            => _tableClient.FindFirst(whereClause, parameters, orderBy);

        public T FindFirst(FindManyArgs args)
            => _tableClient.FindFirst(args);

        public T FindUnique(object id, string idColumnName = "Id")
            => _tableClient.FindUnique(id, idColumnName);

        public T FindUnique(FindManyArgs args)
            => _tableClient.FindUnique(args);

        public int Count(string whereClause = null, Dictionary<string, object> parameters = null)
            => _tableClient.Count(whereClause, parameters);

        public int Count(CountArgs args)
            => _tableClient.Count(args);

        public List<(T Item, double Distance)> VectorSearch(List<double> vector, int take = 10, string whereClause = null, Dictionary<string, object> parameters = null, string vectorField = "Embedding", string distanceMetric = "cosine")
            => _tableClient.VectorSearch(vector, take, whereClause, parameters, vectorField, distanceMetric);

        public List<(T Item, double Distance)> VectorSearch(VectorSearchArgs args)
            => _tableClient.VectorSearch(args);

        public Dictionary<string, object> Aggregate(AggregateArgs args)
            => _tableClient.Aggregate(args);

        public List<T> GroupBy(GroupByArgs args)
            => _tableClient.GroupBy(args);

        public T Create(T entity) => throw new NotSupportedException($"View '{ViewName}' is read-only. Create is not allowed.");
        public T Update(T entity, string idColumnName = "Id") => throw new NotSupportedException($"View '{ViewName}' is read-only. Update is not allowed.");
        public bool Delete(object id, string idColumnName = "Id") => throw new NotSupportedException($"View '{ViewName}' is read-only. Delete is not allowed.");
        public int DeleteMany(string whereClause = null, Dictionary<string, object> parameters = null) => throw new NotSupportedException($"View '{ViewName}' is read-only. DeleteMany is not allowed.");
        public T Upsert(T entity, string idColumnName = "Id") => throw new NotSupportedException($"View '{ViewName}' is read-only. Upsert is not allowed.");
    }

// ─── ORM-style Args types ────────────────────────────────────────────────────

    public class FindManyArgs
    {
        public object Where { get; set; }
        public object OrderBy { get; set; }
        public int? Skip { get; set; }
        public int? Take { get; set; }
        public object Select { get; set; }
        public object Include { get; set; }
    }

    public class CountArgs
    {
        public object Where { get; set; }
    }

    public class CreateArgs
    {
        public Dictionary<string, object> Data { get; set; }
        public object Include { get; set; }
        public object Select { get; set; }
    }

    public class CreateManyArgs
    {
        public List<Dictionary<string, object>> Data { get; set; }
        public bool SkipDuplicates { get; set; }
    }

    public class UpdateArgs
    {
        public object Where { get; set; }
        public Dictionary<string, object> Data { get; set; }
        public object Include { get; set; }
        public object Select { get; set; }
    }

    public class UpdateManyArgs
    {
        public object Where { get; set; }
        public Dictionary<string, object> Data { get; set; }
    }

    public class DeleteManyArgs
    {
        public object Where { get; set; }
    }

    public class UpsertArgs
    {
        public object Where { get; set; }
        public Dictionary<string, object> Create { get; set; }
        public Dictionary<string, object> Update { get; set; }
    }

    public class AggregateArgs
    {
        public object Where { get; set; }
        public object Count { get; set; }
        public object Sum { get; set; }
        public object Avg { get; set; }
        public object Min { get; set; }
        public object Max { get; set; }
    }

    public class GroupByArgs
    {
        public object By { get; set; }
        public object Where { get; set; }
        public object OrderBy { get; set; }
        public int? Skip { get; set; }
        public int? Take { get; set; }
        public object Sum { get; set; }
        public object Avg { get; set; }
        public object Min { get; set; }
        public object Max { get; set; }
    }

    public class VectorSearchArgs
    {
        public List<double> Vector { get; set; }
        public int Take { get; set; } = 10;
        public object Where { get; set; }
        public string VectorField { get; set; } = "Embedding";
        public string DistanceMetric { get; set; } = "cosine";
    }

    internal class DictionaryModel
    {
    }

    internal static class ArgsHelper
    {
        public static List<string> SelectedFields(object select)
        {
            var keys = new List<string>();
            switch (select)
            {
                case null:
                    return keys;
                case string s when !string.IsNullOrEmpty(s):
                    keys.Add(s);
                    return keys;
                case System.Collections.IList list:
                    foreach (var item in list)
                        if (item is string key) keys.Add(key);
                    return keys;
                case Dictionary<string, object> map:
                    foreach (var kv in map)
                        if (kv.Value is bool b && b) keys.Add(kv.Key);
                    return keys;
                case Dictionary<string, bool> bmap:
                    foreach (var kv in bmap)
                        if (kv.Value) keys.Add(kv.Key);
                    return keys;
            }
            return keys;
        }

        public static bool HasRelationSelect(object select, Dictionary<string, RelationDef> relations)
        {
            foreach (var key in SelectedFields(select))
                if (key == "_count" || relations.ContainsKey(key)) return true;
            return false;
        }

        public static List<string> SelectedAggregateFields(object fields)
        {
            var outList = new List<string>();
            switch (fields)
            {
                case null:
                    break;
                case string s when !string.IsNullOrEmpty(s):
                    outList.Add(s);
                    break;
                case System.Collections.IList list:
                    foreach (var item in list)
                        if (item is string key && !string.IsNullOrEmpty(key)) outList.Add(key);
                    break;
                case Dictionary<string, object> map:
                    foreach (var kv in map)
                        if (kv.Value is bool b && b) outList.Add(kv.Key);
                    break;
                case Dictionary<string, bool> bmap:
                    foreach (var kv in bmap)
                        if (kv.Value) outList.Add(kv.Key);
                    break;
            }
            outList.Sort();
            return outList;
        }

        public static List<string> NormalizeByFields(object by)
        {
            var outList = new List<string>();
            switch (by)
            {
                case string s when !string.IsNullOrEmpty(s):
                    outList.Add(s);
                    break;
                case System.Collections.IList list:
                    foreach (var item in list)
                        if (item is string key && !string.IsNullOrEmpty(key)) outList.Add(key);
                    break;
            }
            return outList;
        }

        public static Dictionary<string, object> ProjectDict(Dictionary<string, object> row, object select)
        {
            var projected = new Dictionary<string, object>();
            foreach (var key in SelectedFields(select))
                if (row.TryGetValue(key, out var v)) projected[key] = v;
            if (row.TryGetValue("_count", out var count)) projected["_count"] = count;
            return projected;
        }
    }

// ─── Typed Table Client ────────────────────────────────────────────────────

    public class AdapterTableClient<T> where T : new()
    {
        private readonly An5Adapter _adapter;
        private readonly string _tableName;
        private readonly string _rawTable;
        private readonly string _modelName;
        private readonly Dialect _dialect;

        public AdapterTableClient(An5Adapter adapter, string tableName, Dialect dialect)
        {
            _adapter = adapter;
            _rawTable = tableName;
            _tableName = SqlQuote.QuoteTable(tableName, dialect);
            _modelName = tableName;
            _dialect = dialect;
        }

        public AdapterTableClient(An5Adapter adapter, string tableName, string modelName, Dialect dialect)
        {
            _adapter = adapter;
            _rawTable = tableName;
            _tableName = SqlQuote.QuoteTable(tableName, dialect);
            _modelName = modelName;
            _dialect = dialect;
        }

        public string TableName => _rawTable;
        public string ModelName => _modelName;

        private string Nolock => _dialect == Dialect.Mssql ? " WITH (NOLOCK)" : "";

        private string BuildPagination(string orderBy, int? skip, int? take)
        {
            if (take == null) return "";
            if (_dialect == Dialect.Postgres)
                return $" LIMIT {take.Value} OFFSET {skip ?? 0}";
            var o = !string.IsNullOrEmpty(orderBy) ? $" ORDER BY {orderBy}" : " ORDER BY (SELECT NULL)";
            return $"{o} OFFSET {skip ?? 0} ROWS FETCH NEXT {take.Value} ROWS ONLY";
        }

        public List<T> FindMany(string whereClause = null, Dictionary<string, object> parameters = null,
            string orderBy = null, int? skip = null, int? take = null)
        {
            var sb = new StringBuilder($"SELECT * FROM {_tableName}{Nolock}");
            if (!string.IsNullOrEmpty(whereClause)) sb.Append($" WHERE {whereClause}");
            if (take != null && _dialect == Dialect.Postgres)
            {
                if (!string.IsNullOrEmpty(orderBy)) sb.Append($" ORDER BY {orderBy}");
                if (skip != null) sb.Append($" OFFSET {skip.Value} ROWS");
                sb.Append($" LIMIT {take.Value}");
            }
            else
            {
                if (!string.IsNullOrEmpty(orderBy)) sb.Append($" ORDER BY {orderBy}");
                sb.Append(BuildPagination(orderBy, skip, take));
            }
            return _adapter.QueryRaw<T>(sb.ToString(), parameters);
        }

        public List<T> FindMany(FindManyArgs args)
        {
            var parameters = new Dictionary<string, object>();
            var whereSql = SqlBuilder.ParseWhere(args?.Where, parameters, _dialect);
            var orderSql = SqlBuilder.BuildOrderBy(args?.OrderBy, _dialect);
            var skip = args?.Skip;
            var take = args?.Take;
            var hasSkip = skip != null;

            var cols = "*";
            var keys = ArgsHelper.SelectedFields(args?.Select);
            var isPostgres = _dialect == Dialect.Postgres;

            if (keys.Count > 0 && !ArgsHelper.HasRelationSelect(args?.Select, An5Metadata.GetRelationsForModel(_modelName)))
            {
                var quoted = keys.ConvertAll(k => SqlQuote.QuoteName(k, _dialect));
                cols = string.Join(", ", quoted);
            }

            string query;
            if (take != null && !hasSkip)
            {
                if (!isPostgres)
                {
                    query = $"SELECT TOP ({take.Value}) {cols} FROM {_tableName}{Nolock}";
                    if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
                    if (!string.IsNullOrEmpty(orderSql)) query += $" {orderSql}";
                }
                else
                {
                    query = $"SELECT {cols} FROM {_tableName}";
                    if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
                    if (!string.IsNullOrEmpty(orderSql)) query += $" {orderSql}";
                    query += $" LIMIT {take.Value}";
                }
            }
            else if (hasSkip)
            {
                if (!isPostgres)
                {
                    query = $"SELECT {cols} FROM {_tableName}{Nolock}";
                    if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
                    query += $" {(!string.IsNullOrEmpty(orderSql) ? orderSql : "ORDER BY (SELECT NULL)")}";
                    query += $" OFFSET {skip.Value} ROWS";
                    if (take != null) query += $" FETCH NEXT {take.Value} ROWS ONLY";
                }
                else
                {
                    query = $"SELECT {cols} FROM {_tableName}";
                    if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
                    if (!string.IsNullOrEmpty(orderSql)) query += $" {orderSql}";
                    if (take != null) query += $" LIMIT {take.Value}";
                    else query += " LIMIT ALL";
                    query += $" OFFSET {skip.Value}";
                }
            }
            else
            {
                query = $"SELECT {cols} FROM {_tableName}{Nolock}";
                if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
                if (!string.IsNullOrEmpty(orderSql)) query += $" {orderSql}";
            }

            var rows = _adapter.QueryRaw<T>(query, parameters);

            var include = args?.Include != null && args.Include is Dictionary<string, object> incDict && incDict.Count > 0
                ? incDict
                : null;
            if (include != null)
                ResolveIncludes(rows, include);

            var select = args?.Select;
            if (select != null)
            {
                if (ArgsHelper.HasRelationSelect(select, An5Metadata.GetRelationsForModel(_modelName)))
                    ResolveIncludes(rows, select as Dictionary<string, object>);
                return ApplyProjection(rows, select);
            }

            return rows;
        }

        // ── ORM-standard FindFirst / FindUnique / Count ────────────────────────

        public T FindFirst(FindManyArgs args)
        {
            var list = FindMany(new FindManyArgs
            {
                Where = args?.Where,
                OrderBy = args?.OrderBy,
                Take = 1,
                Select = args?.Select,
                Include = args?.Include,
            });
            return list.Count > 0 ? list[0] : default;
        }

        public T FindUnique(FindManyArgs args)
            => FindFirst(args);

        public int Count(CountArgs args)
        {
            var parameters = new Dictionary<string, object>();
            var whereSql = args != null ? SqlBuilder.ParseWhere(args.Where, parameters, _dialect) : "";
            var sql = $"SELECT COUNT(*) FROM {_tableName}{Nolock}";
            if (!string.IsNullOrEmpty(whereSql)) sql += $" WHERE {whereSql}";
            var rows = _adapter.QueryRaw(sql, parameters);
            if (rows.Count > 0)
            {
                using var e = rows[0].Values.GetEnumerator();
                if (e.MoveNext() && e.Current != null) return Convert.ToInt32(e.Current);
            }
            return 0;
        }

        // ── Projection / Include helpers ──────────────────────────────────────

        private List<T> ApplyProjection(List<T> rows, object select)
        {
            var result = new List<T>();
            var relations = An5Metadata.GetRelationsForModel(_modelName);
            var isDictSelect = select is Dictionary<string, object> || select is Dictionary<string, bool>;
            if (!isDictSelect)
            {
                var props = typeof(T).GetProperties(BindingFlags.Public | BindingFlags.Instance);
                var selectedKeys = new HashSet<string>(ArgsHelper.SelectedFields(select), StringComparer.OrdinalIgnoreCase);
                foreach (var row in rows)
                {
                    var item = new T();
                    foreach (var prop in props)
                        if (selectedKeys.Contains(prop.Name))
                            prop.SetValue(item, prop.GetValue(row));
                    result.Add(item);
                }
                return result;
            }

            // Relation select keys may reference a nested dict; keep it simple and
            // copy only selected top-level properties.
            var dictSelect = select as Dictionary<string, object>;
            var boolSet = select as Dictionary<string, bool>;
            foreach (var row in rows)
            {
                var item = new T();
                var props = typeof(T).GetProperties(BindingFlags.Public | BindingFlags.Instance);
                foreach (var prop in props)
                {
                    if (dictSelect != null && dictSelect.TryGetValue(prop.Name, out var sv) && sv is bool b && b)
                        prop.SetValue(item, prop.GetValue(row));
                    else if (boolSet != null && boolSet.TryGetValue(prop.Name, out var b2) && b2)
                        prop.SetValue(item, prop.GetValue(row));
                }
                result.Add(item);
            }
            _ = relations;
            return result;
        }

        private void ResolveIncludes(List<T> rows, Dictionary<string, object> include)
        {
            if (rows.Count == 0 || include == null || include.Count == 0) return;
            var modelRelations = An5Metadata.GetRelationsForModel(_modelName);
            if (modelRelations.Count == 0) return;

            foreach (var kv in include)
            {
                var key = kv.Key;
                if (kv.Value is bool b && !b) continue;
                if (key == "_count")
                {
                    foreach (var rel in modelRelations)
                    {
                        if (rel.Value.RelationType != "many") continue;
                        var relKeys = new HashSet<object>();
                        foreach (var r in rows)
                        {
                            var lk = GetPropValue(r, rel.Value.LocalKey);
                            if (lk != null) relKeys.Add(lk);
                        }
                        var childClient = new AdapterTableClient<DictionaryModel>(_adapter, rel.Value.ModelName, _dialect);
                        var matches = childClient.FindManyDynamic(new FindManyArgs
                        {
                            Where = new Dictionary<string, object> { { rel.Value.ForeignKey, new Dictionary<string, object> { { "in", ToList(relKeys) } } } },
                        });
                        var cmap = new Dictionary<object, int>();
                        foreach (var m in matches)
                            if (m.ContainsKey(rel.Value.ForeignKey) && m[rel.Value.ForeignKey] != null)
                                cmap[m[rel.Value.ForeignKey]] = cmap.GetValueOrDefault(m[rel.Value.ForeignKey]) + 1;
                        foreach (var r in rows)
                        {
                            var lk = GetPropValue(r, rel.Value.LocalKey);
                            var countProp = typeof(T).GetProperty("_count", BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                            var countBox = countProp != null ? countProp.GetValue(r) as Dictionary<string, object> : null;
                            countBox ??= new Dictionary<string, object>();
                            countBox[rel.Key] = lk != null && cmap.TryGetValue(lk, out var n) ? n : 0;
                            if (countProp != null) TrySetProp(r, "_count", countBox);
                        }
                    }
                    continue;
                }

                var relation = modelRelations.TryGetValue(key, out var rdef) ? rdef : null;
                if (relation == null) continue;
                var isMany = relation.RelationType == "many";
                var joinKey = isMany ? relation.LocalKey : relation.ForeignKey;
                var matchKey = isMany ? relation.ForeignKey : relation.LocalKey;

                var uniqueKeys = new HashSet<object>();
                foreach (var r in rows)
                {
                    var jv = GetPropValue(r, joinKey);
                    if (jv != null) uniqueKeys.Add(jv);
                }
                foreach (var r in rows)
                {
                    if (!isMany) { r.GetType(); }
                }
                if (uniqueKeys.Count == 0)
                {
                    foreach (var r in rows)
                        TrySetProp(r, key, isMany ? new List<object>() : null);
                    continue;
                }

                var childIncludeClient = new AdapterTableClient<DictionaryModel>(_adapter, relation.ModelName, _dialect);
                var subArgs = kv.Value as Dictionary<string, object> ?? new Dictionary<string, object>();
                var subWhere = new Dictionary<string, object>
                {
                    { matchKey, new Dictionary<string, object> { { "in", ToList(uniqueKeys) } } },
                };
                if (subArgs.TryGetValue("where", out var subWhereVal) && subWhereVal is Dictionary<string, object> sw)
                    foreach (var swKv in sw) subWhere[swKv.Key] = swKv.Value;

                var orderBy = subArgs.TryGetValue("orderBy", out var oB) ? oB : null;
                var children = childIncludeClient.FindManyDynamic(new FindManyArgs
                {
                    Where = subWhere,
                    OrderBy = orderBy,
                });

                Dictionary<object, List<Dictionary<string, object>>> groupMap = new();
                foreach (var c in children)
                {
                    var gk = isMany ? (c.ContainsKey(relation.ForeignKey) ? c[relation.ForeignKey] : null)
                                     : (c.ContainsKey(relation.LocalKey) ? c[relation.LocalKey] : null);
                    if (gk == null) continue;
                    if (!groupMap.TryGetValue(gk, out var list)) { list = new List<Dictionary<string, object>>(); groupMap[gk] = list; }
                    list.Add(c);
                }

                foreach (var r in rows)
                {
                    var gk = isMany ? GetPropValue(r, relation.LocalKey) : GetPropValue(r, relation.ForeignKey);
                    var matches = gk != null && groupMap.TryGetValue(gk, out var ml) ? ml : new List<Dictionary<string, object>>();
                    if (isMany)
                        TrySetProp(r, key, matches);
                    else
                        TrySetProp(r, key, matches.Count > 0 ? matches[0] : null);
                }
            }
        }

        private List<Dictionary<string, object>> FindManyDynamic(FindManyArgs args)
        {
            var parameters = new Dictionary<string, object>();
            var whereSql = SqlBuilder.ParseWhere(args?.Where, parameters, _dialect);
            var orderSql = SqlBuilder.BuildOrderBy(args?.OrderBy, _dialect);
            var query = $"SELECT * FROM {_tableName}{Nolock}";
            if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
            if (!string.IsNullOrEmpty(orderSql)) query += $" {orderSql}";
            return _adapter.QueryRaw(query, parameters);
        }

        private static object GetPropValue(object obj, string propName)
        {
            var prop = obj.GetType().GetProperty(propName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            return prop?.GetValue(obj);
        }

        private static void TrySetProp(object obj, string propName, object value)
        {
            var prop = obj.GetType().GetProperty(propName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (prop == null || !prop.CanWrite) return;
            if (value == null) { prop.SetValue(obj, null); return; }
            try
            {
                if (prop.PropertyType.IsAssignableFrom(value.GetType()))
                    prop.SetValue(obj, value);
                else if (prop.PropertyType == typeof(string))
                    prop.SetValue(obj, System.Text.Json.JsonSerializer.Serialize(value));
            }
            catch { }
        }

        private static List<object> ToList(ICollection<object> src)
        {
            var list = new List<object>(src.Count);
            foreach (var item in src) list.Add(item);
            return list;
        }

        // ── ORM-standard Aggregate / GroupBy ───────────────────────────────────

        public Dictionary<string, object> Aggregate(AggregateArgs args)
        {
            args ??= new AggregateArgs();
            var parameters = new Dictionary<string, object>();
            var whereSql = SqlBuilder.ParseWhere(args.Where, parameters, _dialect);
            var aggs = new List<string>();
            var countFields = ArgsHelper.SelectedAggregateFields(args.Count);
            if (countFields.Count == 0 && args.Count != null && args.Count is not bool)
            {
                // noop
            }
            if (args.Count != null)
            {
                if (countFields.Count == 0)
                    aggs.Add("COUNT(*) AS cnt_all");
                else
                    foreach (var f in countFields)
                        aggs.Add($"COUNT({SqlQuote.QuoteName(f, _dialect)}) AS cnt_{ArgsHelper_Sanitize(f)}");
            }
            AddAggregates(aggs, "SUM", args.Sum);
            AddAggregates(aggs, "AVG", args.Avg);
            AddAggregates(aggs, "MIN", args.Min);
            AddAggregates(aggs, "MAX", args.Max);
            if (aggs.Count == 0)
                throw new InvalidOperationException("Aggregate requires at least one aggregator field");

            var sql = $"SELECT {string.Join(", ", aggs)} FROM {_tableName}{Nolock}";
            if (!string.IsNullOrEmpty(whereSql)) sql += $" WHERE {whereSql}";
            var rows = _adapter.QueryRaw(sql, parameters);
            var row = rows.Count > 0 ? rows[0] : new Dictionary<string, object>();
            var result = new Dictionary<string, object>();

            if (args.Count != null)
            {
                var all = ToNumber(row.TryGetValue("cnt_all", out var ca) ? ca : row.TryGetValue("_count", out var cc) ? cc : 0);
                var countRes = new Dictionary<string, object> { { "_all", all } };
                foreach (var f in countFields)
                {
                    if (f == "_all") continue;
                    var v = row.TryGetValue("cnt_" + ArgsHelper_Sanitize(f), out var cv) ? cv : all;
                    countRes[f] = ToNumber(v);
                }
                result["_count"] = countRes;
            }
            AddAggregateResult(result, "sum", "SUM", args.Sum, row);
            AddAggregateResult(result, "avg", "AVG", args.Avg, row);
            AddAggregateResult(result, "min", "MIN", args.Min, row);
            AddAggregateResult(result, "max", "MAX", args.Max, row);
            return result;
        }

        private void AddAggregates(List<string> aggs, string op, object fields)
        {
            foreach (var f in ArgsHelper.SelectedAggregateFields(fields))
                aggs.Add($"{op}({SqlQuote.QuoteName(f, _dialect)}) AS {op.ToLowerInvariant()}_{ArgsHelper_Sanitize(f)}");
        }

        private void AddAggregateResult(Dictionary<string, object> result, string key, string op, object fields, Dictionary<string, object> row)
        {
            var list = ArgsHelper.SelectedAggregateFields(fields);
            if (list.Count == 0) return;
            var sub = new Dictionary<string, object>();
            foreach (var f in list)
            {
                var kk = key + "_" + ArgsHelper_Sanitize(f);
                var v = row.TryGetValue(kk, out var rv) ? rv : null;
                sub[f] = v == null ? null : ToNumber(v);
            }
            result["_" + key] = sub;
        }

        private static string ArgsHelper_Sanitize(string name) => SqlBuilder.SanitizeParamName(name);

        private static double ToNumber(object v)
        {
            if (v == null) return 0;
            try { return Convert.ToDouble(v); } catch { return 0; }
        }

        public List<T> GroupBy(GroupByArgs args)
        {
            args ??= new GroupByArgs();
            var byFields = ArgsHelper.NormalizeByFields(args.By);
            if (byFields.Count == 0)
                throw new InvalidOperationException("groupBy requires 'by' fields");

            var parameters = new Dictionary<string, object>();
            var whereSql = SqlBuilder.ParseWhere(args.Where, parameters, _dialect);
            var byCols = string.Join(", ", byFields.ConvertAll(f => SqlQuote.QuoteName(f, _dialect)));
            var aggs = new List<string> { "COUNT(*) AS _count" };
            AddAggregates(aggs, "SUM", args.Sum);
            AddAggregates(aggs, "AVG", args.Avg);
            AddAggregates(aggs, "MIN", args.Min);
            AddAggregates(aggs, "MAX", args.Max);

            var query = $"SELECT {byCols}, {string.Join(", ", aggs)} FROM {_tableName}";
            if (!string.IsNullOrEmpty(whereSql)) query += $" WHERE {whereSql}";
            query += $" GROUP BY {byCols}";

            var orderSql = SqlBuilder.BuildOrderBy(args.OrderBy, _dialect);
            var hasSkip = args.Skip != null;
            var hasTake = args.Take != null;
            if (!string.IsNullOrEmpty(orderSql)) query += $" {orderSql}";
            else if (hasSkip || hasTake) query += $" ORDER BY {byCols}";
            if (hasSkip || hasTake)
            {
                var skip = args.Skip ?? 0;
                var take = args.Take ?? 1;
                if (_dialect == Dialect.Postgres)
                {
                    if (hasTake) query += $" LIMIT {take}";
                    query += $" OFFSET {skip}";
                }
                else
                {
                    query += $" OFFSET {skip} ROWS";
                    if (hasTake) query += $" FETCH NEXT {take} ROWS ONLY";
                }
            }
            return _adapter.QueryRaw<T>(query, parameters);
        }

        // ── ORM-standard VectorSearch ──────────────────────────────────────────

        public List<(T Item, double Distance)> VectorSearch(VectorSearchArgs args)
        {
            args ??= new VectorSearchArgs();
            return VectorSearch(args.Vector, args.Take, null, null, args.VectorField, args.DistanceMetric);
        }

        public T FindFirst(string whereClause = null, Dictionary<string, object> parameters = null, string orderBy = null)
        {
            var rows = FindMany(whereClause, parameters, orderBy, skip: null, take: 1);
            return rows.Count > 0 ? rows[0] : default;
        }

        public T FindUnique(object id, string idColumnName = "Id")
        {
            return FindFirst($"{SqlQuote.QuoteName(idColumnName, _dialect)} = @id",
                new Dictionary<string, object> { { "id", id } });
        }

        public int Count(string whereClause = null, Dictionary<string, object> parameters = null)
        {
            var sql = $"SELECT COUNT(*) FROM {_tableName}";
            if (!string.IsNullOrEmpty(whereClause)) sql += $" WHERE {whereClause}";
            var rows = _adapter.QueryRaw(sql, parameters);
            if (rows.Count > 0)
            {
                var val = rows[0].Values.GetEnumerator();
                val.MoveNext();
                return Convert.ToInt32(val.Current);
            }
            return 0;
        }

        public T Create(T entity)
        {
            var props = typeof(T).GetProperties(BindingFlags.Public | BindingFlags.Instance);
            var cols = new List<string>();
            var vals = new List<string>();
            var parameters = new Dictionary<string, object>();

            foreach (var prop in props)
            {
                var val = prop.GetValue(entity);
                if (val == null) continue;
                cols.Add(SqlQuote.QuoteName(prop.Name, _dialect));
                vals.Add("@" + prop.Name);
                parameters["@" + prop.Name] = val;
            }

            var sql = $"INSERT INTO {_tableName} ({string.Join(", ", cols)}) VALUES ({string.Join(", ", vals)})";
            _adapter.ExecuteRaw(sql, parameters);
            return entity;
        }

        public T Update(T entity, string idColumnName = "Id")
        {
            var props = typeof(T).GetProperties(BindingFlags.Public | BindingFlags.Instance);
            var sets = new List<string>();
            var parameters = new Dictionary<string, object>();
            object idVal = null;

            foreach (var prop in props)
            {
                var val = prop.GetValue(entity);
                if (prop.Name.Equals(idColumnName, StringComparison.OrdinalIgnoreCase))
                {
                    idVal = val;
                }
                else if (val != null)
                {
                    sets.Add($"{SqlQuote.QuoteName(prop.Name, _dialect)} = @{prop.Name}");
                    parameters["@" + prop.Name] = val;
                }
            }

            if (idVal == null) throw new InvalidOperationException($"Cannot update entity without {idColumnName}");
            parameters["@_id"] = idVal;
            var quotedIdCol = SqlQuote.QuoteName(idColumnName, _dialect);
            var sql = $"UPDATE {_tableName} SET {string.Join(", ", sets)} WHERE {quotedIdCol} = @_id";
            _adapter.ExecuteRaw(sql, parameters);
            return entity;
        }

        public bool Delete(object id, string idColumnName = "Id")
        {
            var quotedIdCol = SqlQuote.QuoteName(idColumnName, _dialect);
            var sql = $"DELETE FROM {_tableName} WHERE {quotedIdCol} = @id";
            var n = _adapter.ExecuteRaw(sql, new Dictionary<string, object> { { "@id", id } });
            return n > 0;
        }

        public int DeleteMany(string whereClause = null, Dictionary<string, object> parameters = null)
        {
            var sql = $"DELETE FROM {_tableName}";
            if (!string.IsNullOrEmpty(whereClause)) sql += $" WHERE {whereClause}";
            return _adapter.ExecuteRaw(sql, parameters);
        }

        public T Upsert(T entity, string idColumnName = "Id")
        {
            var idProp = typeof(T).GetProperty(idColumnName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (idProp == null) throw new InvalidOperationException($"Property {idColumnName} not found on {typeof(T).Name}");
            var idVal = idProp.GetValue(entity);
            var existing = idVal != null ? FindUnique(idVal, idColumnName) : default;
            if (existing != null) return Update(entity, idColumnName);
            return Create(entity);
        }

        // ── Vector Search ──────────────────────────────────────────────────────

        public List<(T Item, double Distance)> VectorSearch(
            List<double> vector, int take = 10,
            string whereClause = null, Dictionary<string, object> parameters = null,
            string vectorField = "Embedding", string distanceMetric = "cosine")
        {
            // 1. Primary path: Native database SQL vector query execution (MSSQL VECTOR_DISTANCE / Postgres pgvector)
            try
            {
                var dim = vector.Count;
                var vecJson = JsonSerializer.Serialize(vector);
                var p = parameters != null ? new Dictionary<string, object>(parameters) : new Dictionary<string, object>();
                p["query_vector"] = vecJson;
                var quotedVectorField = SqlQuote.QuoteName(vectorField, _dialect);

                string sql;
                if (_dialect == Dialect.Postgres)
                {
                    string op = distanceMetric.Equals("cosine", StringComparison.OrdinalIgnoreCase) ? "<=>" :
                               (distanceMetric.Equals("euclidean", StringComparison.OrdinalIgnoreCase) ? "<->" : "<#>");
                    sql = $"SELECT *, ({quotedVectorField} {op} @query_vector::vector) AS distance FROM {_tableName}";
                    if (!string.IsNullOrWhiteSpace(whereClause))
                        sql += $" WHERE {quotedVectorField} IS NOT NULL AND ({whereClause})";
                    else
                        sql += $" WHERE {quotedVectorField} IS NOT NULL";
                    sql += $" ORDER BY distance ASC LIMIT {take}";
                }
                else
                {
                    sql = $"SELECT TOP ({take}) *, VECTOR_DISTANCE('{distanceMetric}', CAST({quotedVectorField} AS VECTOR({dim}, float32)), CAST(@query_vector AS VECTOR({dim}, float32))) AS distance FROM {_tableName}{Nolock}";
                    if (!string.IsNullOrWhiteSpace(whereClause))
                        sql += $" WHERE {quotedVectorField} IS NOT NULL AND ({whereClause})";
                    else
                        sql += $" WHERE {quotedVectorField} IS NOT NULL";
                    sql += " ORDER BY distance ASC";
                }

                var nativeRows = _adapter.QueryRaw<T>(sql, p);
                if (nativeRows != null && nativeRows.Count > 0)
                {
                    var nativeResults = new List<(T, double)>();
                    foreach (var row in nativeRows)
                    {
                        var distanceProp = typeof(T).GetProperty("Distance", BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                        double dist = 0;
                        if (distanceProp != null && distanceProp.GetValue(row) is double dVal)
                        {
                            dist = dVal;
                        }
                        nativeResults.Add((row, dist));
                    }
                    return nativeResults;
                }
            }
            catch
            {
                // Secondary fallback: In-memory similarity computation if DB instance lacks native vector extension
            }

            // 2. Secondary fallback: In-memory similarity computation
            var rows = FindMany(whereClause, parameters);
            var results = new List<(T, double)>();
            var vectorProp = typeof(T).GetProperty(vectorField, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (vectorProp == null) return results;

            foreach (var row in rows)
            {
                var rawVal = vectorProp.GetValue(row);
                if (rawVal == null) continue;
                List<double> vec = null;
                try
                {
                    if (rawVal is string s) vec = JsonSerializer.Deserialize<List<double>>(s);
                }
                catch { continue; }
                if (vec == null || vec.Count != vector.Count) continue;

                double dot = 0, m1 = 0, m2 = 0;
                for (int i = 0; i < vector.Count; i++)
                {
                    dot += vector[i] * vec[i];
                    m1 += vector[i] * vector[i];
                    m2 += vec[i] * vec[i];
                }
                double cosine = (m1 > 0 && m2 > 0) ? dot / (Math.Sqrt(m1) * Math.Sqrt(m2)) : 0;
                double dist = distanceMetric.Equals("cosine", StringComparison.OrdinalIgnoreCase) ? 1.0 - cosine :
                              distanceMetric.Equals("dot", StringComparison.OrdinalIgnoreCase) ? -dot : EuclideanDistance(vector, vec);
                results.Add((row, dist));
            }

            results.Sort((a, b) => a.Item2.CompareTo(b.Item2));
            return results.GetRange(0, Math.Min(take, results.Count));
        }

        private static double EuclideanDistance(List<double> left, List<double> right)
        {
            double sum = 0;
            for (int i = 0; i < left.Count; i++)
            {
                var diff = left[i] - right[i];
                sum += diff * diff;
            }
            return Math.Sqrt(sum);
        }
    }
}
