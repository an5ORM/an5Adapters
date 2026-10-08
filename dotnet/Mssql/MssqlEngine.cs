using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Reflection;
using Microsoft.Data.SqlClient;

namespace An5Orm
{
// ─── MSSQL Engine ──────────────────────────────────────────────────────────

    internal class MssqlEngine : IQueryEngine
    {
        public Dialect Dialect => Dialect.Mssql;
        // Only SQLite has a vector hook; this provider has none to offer.
        public SqliteVectorSupport VectorSupport => null;
        private readonly string _connectionString;
        private readonly int _commandTimeout;

        [ThreadStatic] private static SqlConnection _txConn;
        [ThreadStatic] private static SqlTransaction _tx;

        public MssqlEngine(string connectionString, int commandTimeout)
        {
            _connectionString = connectionString;
            _commandTimeout = commandTimeout;
        }

        private SqlConnection OpenConnection(out bool isInTransaction)
        {
            if (_txConn != null) { isInTransaction = true; return _txConn; }
            isInTransaction = false;
            var conn = new SqlConnection(_connectionString);
            conn.Open();
            return conn;
        }

        /// <summary>
        /// Converts a value into something SqlClient can bind.
        /// </summary>
        /// <remarks>
        /// A <c>VECTOR</c> column is transmitted as a JSON array over TDS, so a float or
        /// double array is written in that form. Binding the array itself is not an option:
        /// SqlClient has no mapping for it, and the failure names the array rather than the
        /// column. Driver versions before 6.1 have no <c>SqlVector</c> either, so the JSON
        /// form is what every version accepts.
        /// </remarks>
        private static object BindableValue(object value)
        {
            if (value is float[] floats)
            {
                var parts = new string[floats.Length];
                for (int i = 0; i < floats.Length; i++) parts[i] = floats[i].ToString("R", CultureInfo.InvariantCulture);
                return "[" + string.Join(", ", parts) + "]";
            }
            if (value is double[] doubles)
            {
                var parts = new string[doubles.Length];
                for (int i = 0; i < doubles.Length; i++) parts[i] = doubles[i].ToString("R", CultureInfo.InvariantCulture);
                return "[" + string.Join(", ", parts) + "]";
            }
            return value;
        }

        private SqlCommand BuildCommand(
            SqlConnection conn, string sql, Dictionary<string, object> parameters)
        {
            var cmd = new SqlCommand(sql, conn) { CommandTimeout = _commandTimeout };
            if (_tx != null) cmd.Transaction = _tx;
            if (parameters != null)
            {
                foreach (var kv in parameters)
                {
                    var paramName = kv.Key.StartsWith("@") ? kv.Key : "@" + kv.Key;
                    cmd.Parameters.AddWithValue(paramName, BindableValue(kv.Value) ?? DBNull.Value);
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
                        // A `VECTOR` column arrives as a JSON array, which no converter
                        // bridges to the `float[]` the entity declares.
                        if (prop.PropertyType == typeof(float[]))
                        {
                            var vector = SqliteVectors.DecodeVector(val);
                            if (vector != null)
                            {
                                var floats = new float[vector.Count];
                                for (int i = 0; i < vector.Count; i++) floats[i] = (float)vector[i];
                                prop.SetValue(item, floats);
                                continue;
                            }
                        }
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

        private static bool HasColumn(SqlDataReader reader, string name)
        {
            for (int i = 0; i < reader.FieldCount; i++)
                if (reader.GetName(i).Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        public An5TransactionBase BeginTransaction()
        {
            var conn = new SqlConnection(_connectionString);
            conn.Open();
            var tx = conn.BeginTransaction();
            _txConn = conn;
            _tx = tx;
            return new MssqlTransaction(conn, tx, () => { _txConn = null; _tx = null; });
        }
    }

    internal class MssqlTransaction : An5TransactionBase
    {
        private readonly SqlConnection _conn;
        private readonly SqlTransaction _tx;
        private readonly Action _cleanup;

        public MssqlTransaction(SqlConnection conn, SqlTransaction tx, Action cleanup)
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
