using System;
using System.Collections.Generic;
using System.Data;
using System.Reflection;

namespace An5Orm
{
// ─── MSSQL Engine ──────────────────────────────────────────────────────────

    internal class MssqlEngine : IQueryEngine
    {
        public Dialect Dialect => Dialect.Mssql;
        private readonly string _connectionString;
        private readonly int _commandTimeout;

        [ThreadStatic] private static System.Data.SqlClient.SqlConnection _txConn;
        [ThreadStatic] private static System.Data.SqlClient.SqlTransaction _tx;

        public MssqlEngine(string connectionString, int commandTimeout)
        {
            _connectionString = connectionString;
            _commandTimeout = commandTimeout;
        }

        private System.Data.SqlClient.SqlConnection OpenConnection(out bool isInTransaction)
        {
            if (_txConn != null) { isInTransaction = true; return _txConn; }
            isInTransaction = false;
            var conn = new System.Data.SqlClient.SqlConnection(_connectionString);
            conn.Open();
            return conn;
        }

        private System.Data.SqlClient.SqlCommand BuildCommand(
            System.Data.SqlClient.SqlConnection conn, string sql, Dictionary<string, object> parameters)
        {
            var cmd = new System.Data.SqlClient.SqlCommand(sql, conn) { CommandTimeout = _commandTimeout };
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

        private static bool HasColumn(System.Data.SqlClient.SqlDataReader reader, string name)
        {
            for (int i = 0; i < reader.FieldCount; i++)
                if (reader.GetName(i).Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public An5TransactionBase BeginTransaction()
        {
            var conn = new System.Data.SqlClient.SqlConnection(_connectionString);
            conn.Open();
            var tx = conn.BeginTransaction();
            _txConn = conn;
            _tx = tx;
            return new MssqlTransaction(conn, tx, () => { _txConn = null; _tx = null; });
        }
    }

    internal class MssqlTransaction : An5TransactionBase
    {
        private readonly System.Data.SqlClient.SqlConnection _conn;
        private readonly System.Data.SqlClient.SqlTransaction _tx;
        private readonly Action _cleanup;

        public MssqlTransaction(System.Data.SqlClient.SqlConnection conn, System.Data.SqlClient.SqlTransaction tx, Action cleanup)
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
