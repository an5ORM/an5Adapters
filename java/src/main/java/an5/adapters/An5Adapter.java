package an5.adapters;

import an5.adapters.base.Dialect;
import an5.adapters.base.JdbcUrls;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * The AN5 runtime adapter for Java: a connection holder plus raw SQL execution.
 *
 * <p>Model knowledge lives in {@link an5.adapters.base.Metadata}, which the generated
 * client fills in at start-up. Queries go through {@link #table(String)}; this class is
 * only the layer underneath that needs to know about connections and dialect.
 *
 * <p>Instances are not thread-safe, exactly like the other AN5 adapters: the transaction
 * slot below holds one open connection that every statement has to share.
 */
public class An5Adapter implements AutoCloseable {

  /** The unit of work a {@link #transaction} runs. */
  public interface TransactionWork<T> {
    T run(An5Adapter adapter) throws SQLException;
  }

  private final Dialect dialect;
  private final String connectionString;

  /**
   * The open connection of {@link #transaction}, when there is one. Every statement in the
   * callback has to use this very connection, otherwise a rollback returns to a different,
   * already committed connection — that is "the error was raised but the data is still there".
   */
  private Connection transactionConnection;

  /** Long-lived connection for in-memory databases, where closing loses the data. */
  private Connection sharedConnection;

  public An5Adapter(String connectionString) {
    this.connectionString = connectionString;
    this.dialect = Dialect.detect(connectionString);
  }

  public Dialect dialect() {
    return dialect;
  }

  /** Opens and returns a fresh connection; the caller closes it. */
  public Connection connect() throws SQLException {
    String url = JdbcUrls.url(connectionString);
    String[] credentials = JdbcUrls.credentials(connectionString);
    Properties properties = JdbcUrls.properties(credentials[0], credentials[1]);
    Connection connection = DriverManager.getConnection(url, properties);
    if (dialect == Dialect.SQLITE) {
      // SQLite defaults foreign keys OFF, unlike every other dialect, so a schema that
      // relies on them would silently accept rows nothing points at.
      try {
        connection.createStatement().execute("PRAGMA foreign_keys = ON");
      } catch (SQLException ignored) {
        // A driver without PRAGMA support is not a reason to fail the connection.
      }
    }
    return connection;
  }

  /**
   * The connection a statement runs on, and whether this call opened it.
   *
   * <p>An in-memory SQLite database is gone once every connection is closed, so
   * {@link #sharedConnection} is kept open for its whole lifetime.
   */
  private Connection acquire(boolean[] owned) throws SQLException {
    if (transactionConnection != null) {
      owned[0] = false;
      return transactionConnection;
    }
    if (dialect == Dialect.SQLITE && JdbcUrls.isMemory(connectionString)) {
      if (sharedConnection == null) {
        sharedConnection = connect();
      }
      owned[0] = false;
      return sharedConnection;
    }
    owned[0] = true;
    return connect();
  }

  @Override
  public void close() {
    if (sharedConnection != null) {
      try {
        sharedConnection.close();
      } catch (SQLException ignored) {
        // Closing is best effort; the pool owner reports real failures.
      }
      sharedConnection = null;
    }
  }

  /** Runs a query and returns its rows as ordered maps keyed by column label. */
  public List<Map<String, Object>> exec(String query) throws SQLException {
    return exec(query, Collections.<Object>emptyList());
  }

  public List<Map<String, Object>> exec(String query, List<Object> params) throws SQLException {
    boolean[] owned = new boolean[1];
    Connection connection = acquire(owned);
    try {
      PreparedStatement statement = prepare(connection, query, params);
      try {
        ResultSet results = statement.executeQuery();
        try {
          return readRows(results);
        } finally {
          results.close();
        }
      } finally {
        statement.close();
      }
    } finally {
      if (owned[0]) {
        connection.close();
      }
    }
  }

  /** Runs a statement that returns no rows and gives back the affected row count. */
  public int execute(String query) throws SQLException {
    return execute(query, Collections.<Object>emptyList());
  }

  public int execute(String query, List<Object> params) throws SQLException {
    boolean[] owned = new boolean[1];
    Connection connection = acquire(owned);
    try {
      PreparedStatement statement = prepare(connection, query, params);
      try {
        return statement.executeUpdate();
      } finally {
        statement.close();
      }
    } finally {
      if (owned[0]) {
        connection.close();
      }
    }
  }

  public List<Map<String, Object>> queryRaw(String query, Object... params) throws SQLException {
    return exec(query, toList(params));
  }

  public int executeRaw(String query, Object... params) throws SQLException {
    return execute(query, toList(params));
  }

  /** The table client for a model, or for a view name on {@link #view(String)}. */
  public An5TableClient table(String modelName) {
    return new An5TableClient(this, modelName);
  }

  /** A read-only client for a database view. */
  public An5ViewClient view(String viewName) {
    return new An5ViewClient(this, viewName);
  }

  /**
   * Runs work inside a transaction, committing on return and rolling back on failure.
   *
   * <p>Nesting is rejected rather than flattened: an inner commit would make the outer
   * rollback a partial save, which is the opposite of what the caller asked for.
   */
  public <T> T transaction(TransactionWork<T> work) throws SQLException {
    if (transactionConnection != null) {
      throw new IllegalStateException("Nested transaction() is not supported");
    }
    boolean[] owned = new boolean[1];
    Connection connection = acquire(owned);
    boolean previousAutoCommit = connection.getAutoCommit();
    connection.setAutoCommit(false);
    transactionConnection = connection;
    try {
      T result = work.run(this);
      connection.commit();
      return result;
    } catch (SQLException error) {
      connection.rollback();
      throw error;
    } catch (RuntimeException error) {
      connection.rollback();
      throw error;
    } catch (Error error) {
      connection.rollback();
      throw error;
    } finally {
      transactionConnection = null;
      connection.setAutoCommit(previousAutoCommit);
      if (owned[0]) {
        connection.close();
      }
    }
  }

  public List<Map<String, Object>> queryProc(String procName, List<Object> params) throws SQLException {
    return exec(callStatement(procName, params, false), params);
  }

  public int executeProc(String procName, List<Object> params) throws SQLException {
    return execute(callStatement(procName, params, true), params);
  }

  /**
   * SQLite has no stored procedures.
   *
   * <p>This used to fall through to the MSSQL branch and emit {@code EXEC ...}, which is not
   * valid SQL anywhere; the error only surfaced at the call. Saying so beats sending wrong SQL.
   */
  private String callStatement(String procName, List<Object> params, boolean forExecute) {
    if (dialect == Dialect.SQLITE) {
      throw new UnsupportedOperationException(
          "SQLite has no stored procedures. Use the generated table client "
              + "(db.table(\"Model\").findMany()) or db.exec() with a parameterised query.");
    }
    int count = params == null ? 0 : params.size();
    List<String> placeholders = new ArrayList<String>();
    for (int i = 0; i < count; i++) {
      placeholders.add(dialect.placeholder());
    }
    String joined = placeholders.isEmpty() ? "" : join(placeholders, ", ");
    if (dialect == Dialect.POSTGRES) {
      return joined.isEmpty()
          ? "CALL " + procName + "()"
          : "CALL " + procName + "(" + joined + ")";
    }
    return joined.isEmpty() ? "EXEC " + procName : "EXEC " + procName + " " + joined;
  }

  private PreparedStatement prepare(Connection connection, String query, List<Object> params)
      throws SQLException {
    PreparedStatement statement = connection.prepareStatement(query);
    if (params != null) {
      for (int i = 0; i < params.size(); i++) {
        Object value = params.get(i);
        if (value == null) {
          statement.setNull(i + 1, Types.NULL);
        } else {
          statement.setObject(i + 1, value);
        }
      }
    }
    return statement;
  }

  private static List<Map<String, Object>> readRows(ResultSet results) throws SQLException {
    List<Map<String, Object>> rows = new ArrayList<Map<String, Object>>();
    ResultSetMetaData meta = results.getMetaData();
    int columns = meta.getColumnCount();
    while (results.next()) {
      // LinkedHashMap so a row keeps the column order of the SELECT, which is what makes a
      // serialised row read the same way every time.
      Map<String, Object> row = new LinkedHashMap<String, Object>();
      for (int i = 1; i <= columns; i++) {
        row.put(meta.getColumnLabel(i), results.getObject(i));
      }
      rows.add(row);
    }
    return rows;
  }

  private static List<Object> toList(Object[] params) {
    if (params == null || params.length == 0) {
      return Collections.emptyList();
    }
    List<Object> list = new ArrayList<Object>(params.length);
    for (Object param : params) {
      list.add(param);
    }
    return list;
  }

  private static String join(List<String> parts, String separator) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < parts.size(); i++) {
      if (i > 0) {
        out.append(separator);
      }
      out.append(parts.get(i));
    }
    return out.toString();
  }
}