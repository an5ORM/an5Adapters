using System;
using System.Collections.Generic;
using System.Data;
using System.Reflection;

namespace An5Orm
{
    // ─── SQLite Engine ──────────────────────────────────────────────────────────
    //
    // Microsoft.Data.Sqlite is a different type family from the other two
    // providers (SqliteConnection/SqliteCommand, not DbConnection subclasses you
    // can reuse), so it gets its own engine rather than a shared abstraction.
    //
    // Notable differences from MSSQL, all handled by the SQL builder in
    // An5Adapter rather than here: no WITH (NOLOCK) table hint, no SELECT TOP,
    // LIMIT/OFFSET instead of OFFSET/FETCH NEXT, and no stored procedures.

    internal class SqliteEngine : IQueryEngine
    {
        public Dialect Dialect => Dialect.Sqlite;
        private readonly string _connectionString;
        private readonly int _commandTimeout;

        public SqliteEngine(string connectionString, int commandTimeout)
        {
            _connectionString = SqliteConnectionString.Normalize(connectionString);
            _commandTimeout = commandTimeout;
        }

        // Set while a transaction is open; statements then join it instead of
        // opening a second connection, which SQLite would refuse.
        private Microsoft.Data.Sqlite.SqliteConnection _txnConn;

        private Microsoft.Data.Sqlite.SqliteConnection OpenNewConnection()
        {
            var conn = new Microsoft.Data.Sqlite.SqliteConnection(_connectionString);
            conn.Open();
            // WAL keeps readers from blocking the writer, and foreign keys are
            // off by default in SQLite even when the schema declares them.
            using var pragma = conn.CreateCommand();
            pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;";
            pragma.ExecuteNonQuery();
            return conn;
        }

        private ConnectionScope<Microsoft.Data.Sqlite.SqliteConnection> Acquire()
            => _txnConn != null
                ? new ConnectionScope<Microsoft.Data.Sqlite.SqliteConnection>(_txnConn, owned: false)
                : new ConnectionScope<Microsoft.Data.Sqlite.SqliteConnection>(OpenNewConnection(), owned: true);

        private Microsoft.Data.Sqlite.SqliteCommand BuildCommand(
            Microsoft.Data.Sqlite.SqliteConnection conn, string sql, Dictionary<string, object> parameters)
        {
            var cmd = conn.CreateCommand();
            cmd.CommandText = sql;
            cmd.CommandTimeout = _commandTimeout;
            if (parameters != null)
            {
                foreach (var kv in parameters)
                {
                    // SqliteParameter names must not carry the prefix; the SQL
                    // keeps @name and the parameter is registered as name.
                    var paramName = kv.Key.TrimStart('@');
                    var value = kv.Value ?? DBNull.Value;

                    var param = cmd.CreateParameter();
                    param.ParameterName = paramName;
                    // A JSON vector or a bool needs a type SQLite will store in a
                    // column rather than coerce to an integer.
                    if (value is bool flag) param.Value = flag ? 1 : 0;
                    else param.Value = value;
                    cmd.Parameters.Add(param);
                }
            }
            return cmd;
        }

        public List<Dictionary<string, object>> QueryRaw(string sql, Dictionary<string, object> parameters)
        {
            var results = new List<Dictionary<string, object>>();
            using var scope = Acquire();
            using var cmd = BuildCommand(scope.Connection, sql, parameters);
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
            using var scope = Acquire();
            using var cmd = BuildCommand(scope.Connection, sql, parameters);
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
            using var scope = Acquire();
            using var cmd = BuildCommand(scope.Connection, sql, parameters);
            return cmd.ExecuteNonQuery();
        }

        private static bool HasColumn(Microsoft.Data.Sqlite.SqliteDataReader reader, string name)
        {
            for (int i = 0; i < reader.FieldCount; i++)
                if (reader.GetName(i).Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>Detaches the transaction connection, so later statements open their own.</summary>
        internal void ReleaseTransactionConnection() => _txnConn = null;

        public An5TransactionBase BeginTransaction()
        {
            if (_txnConn != null)
                throw new InvalidOperationException("A transaction is already open on this adapter.");
            var conn = OpenNewConnection();
            var tx = conn.BeginTransaction();
            _txnConn = conn;
            return new SqliteTransaction(this, conn, tx);
        }
    }

    internal class SqliteTransaction : An5TransactionBase
    {
        private readonly SqliteEngine _engine;
        private readonly Microsoft.Data.Sqlite.SqliteConnection _conn;
        private readonly Microsoft.Data.Sqlite.SqliteTransaction _tx;

        public SqliteTransaction(SqliteEngine engine, Microsoft.Data.Sqlite.SqliteConnection conn, Microsoft.Data.Sqlite.SqliteTransaction tx)
        {
            _engine = engine;
            _conn = conn;
            _tx = tx;
        }

        public override void Commit() { _tx.Commit(); }

        public override void Rollback() { _tx.Rollback(); }

        public override void Dispose()
        {
            _engine.ReleaseTransactionConnection();
            _tx.Dispose();
            _conn.Dispose();
        }
    }

    // ─── Connection string normalisation ──────────────────────────────────────

    internal static class SqliteConnectionString
    {
        /// <summary>
        /// Turns the accepted spellings into a Data Source string.
        ///
        /// Microsoft.Data.Sqlite only understands `Data Source=`, so the bare
        /// paths and `sqlite:` URLs the rest of the ORM accepts have to be
        /// rewritten. An in-memory database has to stay open for the life of the
        /// connection, which is why callers keep one connection per operation
        /// open only for the duration of a statement.
        /// </summary>
        public static string Normalize(string connectionString)
        {
            var cs = (connectionString ?? "").Trim();
            if (cs.Length == 0) return "Data Source=:memory:";

            // Already a Microsoft.Data.Sqlite connection string.
            if (cs.IndexOf("Data Source", StringComparison.OrdinalIgnoreCase) >= 0
                || cs.IndexOf("DataSource", StringComparison.OrdinalIgnoreCase) >= 0
                || cs.IndexOf("Mode", StringComparison.OrdinalIgnoreCase) >= 0)
                return cs;

            if (cs == ":memory:")
                return "Data Source=:memory:";

            if (cs.StartsWith("sqlite://", StringComparison.OrdinalIgnoreCase))
                return "Data Source=" + cs.Substring("sqlite://".Length);

            if (cs.StartsWith("sqlite:", StringComparison.OrdinalIgnoreCase))
            {
                // `sqlite:app.db` and `sqlite::memory:`
                return "Data Source=" + cs.Substring("sqlite:".Length);
            }

            if (cs.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
                return cs; // SQLite URI, understood as-is.

            // A bare path.
            return "Data Source=" + cs;
        }
    }
}
