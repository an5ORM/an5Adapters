using System;
using System.Collections.Generic;
using System.Data;
using System.Reflection;

namespace An5Orm
{
// ─── PostgreSQL Engine ─────────────────────────────────────────────────────

    internal class PostgresEngine : IQueryEngine
    {
        public Dialect Dialect => Dialect.Postgres;
        // Only SQLite has a vector hook; this provider has none to offer.
        public SqliteVectorSupport VectorSupport => null;
        private readonly string _connectionString;
        private readonly int _commandTimeout;

        // Same shape as MssqlEngine: while a transaction is open, statements
        // have to run on its connection and carry its transaction, or they land
        // outside it and commit/rollback do not cover them.
        [ThreadStatic] private static Npgsql.NpgsqlConnection _txConn;
        [ThreadStatic] private static Npgsql.NpgsqlTransaction _tx;

        public PostgresEngine(string connectionString, int commandTimeout)
        {
            _connectionString = connectionString;
            _commandTimeout = commandTimeout;
        }

        private Npgsql.NpgsqlConnection OpenConnection(out bool isInTransaction)
        {
            if (_txConn != null) { isInTransaction = true; return _txConn; }
            isInTransaction = false;
            var conn = new Npgsql.NpgsqlConnection(_connectionString);
            conn.Open();
            return conn;
        }

        private Npgsql.NpgsqlCommand BuildCommand(
            Npgsql.NpgsqlConnection conn, string sql, Dictionary<string, object> parameters)
        {
            var cmd = new Npgsql.NpgsqlCommand(sql, conn) { CommandTimeout = _commandTimeout };
            if (_tx != null) cmd.Transaction = _tx;
            if (parameters != null)
            {
                foreach (var kv in parameters)
                {
                    var paramName = kv.Key.StartsWith("@") ? kv.Key : "@" + kv.Key;
                    cmd.Parameters.AddWithValue(paramName, kv.Value ?? DBNull.Value);
                }
            }
            return cmd;
        }

        public List<Dictionary<string, object>> QueryRaw(string sql, Dictionary<string, object> parameters)
        {
            var results = new List<Dictionary<string, object>>();
            var conn = OpenConnection(out bool isTx);
            try
            {
                using var cmd = BuildCommand(conn, sql, parameters);
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    var row = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                    for (int i = 0; i < reader.FieldCount; i++)
                    {
                        row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                    }
                    results.Add(row);
                }
            }
            finally { if (!isTx) conn.Dispose(); }
            return results;
        }

        public List<T> QueryRaw<T>(string sql, Dictionary<string, object> parameters) where T : new()
        {
            var results = new List<T>();
            var conn = OpenConnection(out bool isTx);
            try
            {
                using var cmd = BuildCommand(conn, sql, parameters);
                using var reader = cmd.ExecuteReader();
                var props = typeof(T).GetProperties(BindingFlags.Public | BindingFlags.Instance);
                while (reader.Read())
                {
                    var item = new T();
                    foreach (var prop in props)
                    {
                        if (!HasColumn(reader, prop.Name)) continue;
                        var val = reader[prop.Name];
                        if (val == DBNull.Value) continue;
                        try { prop.SetValue(item, Convert.ChangeType(val, prop.PropertyType)); } catch { }
                    }
                    results.Add(item);
                }
            }
            finally { if (!isTx) conn.Dispose(); }
            return results;
        }

        public int ExecuteRaw(string sql, Dictionary<string, object> parameters)
        {
            var conn = OpenConnection(out bool isTx);
            try
            {
                using var cmd = BuildCommand(conn, sql, parameters);
                return cmd.ExecuteNonQuery();
            }
            finally { if (!isTx) conn.Dispose(); }
        }

        private static bool HasColumn(Npgsql.NpgsqlDataReader reader, string name)
        {
            for (int i = 0; i < reader.FieldCount; i++)
                if (reader.GetName(i).Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public An5TransactionBase BeginTransaction()
        {
            if (_txConn != null)
                throw new InvalidOperationException("A transaction is already open on this thread.");
            var conn = new Npgsql.NpgsqlConnection(_connectionString);
            conn.Open();
            var tx = conn.BeginTransaction();
            _txConn = conn;
            _tx = tx;
            return new PostgresTransaction(conn, tx, () => { _txConn = null; _tx = null; });
        }
    }

    internal class PostgresTransaction : An5TransactionBase
    {
        private readonly Npgsql.NpgsqlConnection _conn;
        private readonly Npgsql.NpgsqlTransaction _tx;
        private readonly Action _cleanup;

        public PostgresTransaction(Npgsql.NpgsqlConnection conn, Npgsql.NpgsqlTransaction tx, Action cleanup)
        {
            _conn = conn;
            _tx = tx;
            _cleanup = cleanup;
        }

        public override void Commit() { _tx.Commit(); _cleanup(); }
        public override void Rollback() { _tx.Rollback(); _cleanup(); }
        public override void Dispose() { _tx.Dispose(); _conn.Dispose(); _cleanup(); }
    }
}
