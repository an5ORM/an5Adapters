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
        private readonly string _connectionString;
        private readonly int _commandTimeout;

        public PostgresEngine(string connectionString, int commandTimeout)
        {
            _connectionString = connectionString;
            _commandTimeout = commandTimeout;
        }

        private Npgsql.NpgsqlConnection OpenConnection()
        {
            var conn = new Npgsql.NpgsqlConnection(_connectionString);
            conn.Open();
            return conn;
        }

        private Npgsql.NpgsqlCommand BuildCommand(
            Npgsql.NpgsqlConnection conn, string sql, Dictionary<string, object> parameters)
        {
            var cmd = new Npgsql.NpgsqlCommand(sql, conn) { CommandTimeout = _commandTimeout };
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
            using var conn = OpenConnection();
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
            return results;
        }

        public List<T> QueryRaw<T>(string sql, Dictionary<string, object> parameters) where T : new()
        {
            var results = new List<T>();
            using var conn = OpenConnection();
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
            return results;
        }

        public int ExecuteRaw(string sql, Dictionary<string, object> parameters)
        {
            using var conn = OpenConnection();
            using var cmd = BuildCommand(conn, sql, parameters);
            return cmd.ExecuteNonQuery();
        }

        private static bool HasColumn(Npgsql.NpgsqlDataReader reader, string name)
        {
            for (int i = 0; i < reader.FieldCount; i++)
                if (reader.GetName(i).Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public An5TransactionBase BeginTransaction()
        {
            var conn = OpenConnection();
            var tx = conn.BeginTransaction();
            return new PostgresTransaction(conn, tx);
        }
    }

    internal class PostgresTransaction : An5TransactionBase
    {
        private readonly Npgsql.NpgsqlConnection _conn;
        private readonly Npgsql.NpgsqlTransaction _tx;

        public PostgresTransaction(Npgsql.NpgsqlConnection conn, Npgsql.NpgsqlTransaction tx)
        {
            _conn = conn;
            _tx = tx;
        }

        public override void Commit() { _tx.Commit(); }
        public override void Rollback() { _tx.Rollback(); }
        public override void Dispose() { _tx.Dispose(); _conn.Dispose(); }
    }
}
