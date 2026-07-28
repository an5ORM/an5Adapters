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

        // ── Table client factory ───────────────────────────────────────────────

        public AdapterTableClient<T> Table<T>(string tableName) where T : new()
            => new AdapterTableClient<T>(this, tableName, _engine.Dialect);

        public void Dispose() { }
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

// ─── Typed Table Client ────────────────────────────────────────────────────

    public class AdapterTableClient<T> where T : new()
    {
        private readonly An5Adapter _adapter;
        private readonly string _tableName;
        private readonly Dialect _dialect;

        public AdapterTableClient(An5Adapter adapter, string tableName, Dialect dialect)
        {
            _adapter = adapter;
            _tableName = SqlQuote.QuoteTable(tableName, dialect);
            _dialect = dialect;
        }

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
                sb.Append(BuildPagination(orderBy, skip, take));
            }
            else
            {
                if (!string.IsNullOrEmpty(orderBy)) sb.Append($" ORDER BY {orderBy}");
                sb.Append(BuildPagination(orderBy, skip, take));
            }
            return _adapter.QueryRaw<T>(sb.ToString(), parameters);
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
                double dist = distanceMetric == "cosine" ? 1.0 - cosine :
                              distanceMetric == "dot" ? -dot : Math.Sqrt(vector.Count);
                results.Add((row, dist));
            }

            results.Sort((a, b) => a.Item2.CompareTo(b.Item2));
            return results.GetRange(0, Math.Min(take, results.Count));
        }
    }
}
