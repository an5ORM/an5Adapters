package an5.adapters.base;

import java.util.Locale;
import java.util.Properties;

/**
 * Connection strings to JDBC URLs.
 *
 * <p>A JDBC URL is mandatory and positional, while the connection strings the rest of AN5
 * takes are ADO-style or URI-style. Every environment spellings are accepted here so a
 * project can keep one {@code DATABASE_URL} across all its clients.
 */
public final class JdbcUrls {

  private JdbcUrls() {}

  /** The JDBC URL for a connection string, for the dialect it points at. */
  public static String url(String connectionString) {
    Dialect dialect = Dialect.detect(connectionString);
    String url = urlFor(dialect, connectionString);
    if (url != null) {
      return url;
    }
    throw new IllegalArgumentException(
        "Unsupported connection string for " + dialect.id() + ": " + connectionString);
  }

  private static String urlFor(Dialect dialect, String connectionString) {
    if (connectionString == null) {
      return null;
    }
    String value = connectionString.trim();
    if (dialect == Dialect.SQLITE) {
      return sqliteUrl(value);
    }
    if (dialect == Dialect.POSTGRES) {
      return postgresUrl(value);
    }
    return mssqlUrl(value);
  }

  /**
   * SQLite needs no server, so the path is the whole URL.
   *
   * <p>The {@code sqlite:} and {@code sqlite://} wrappers are stripped one at a time and
   * only then is {@code file:} looked for: {@code sqlite:file::memory:?cache=shared} is
   * only a URI after {@code sqlite:} is gone, so one combined check would miss it.
   */
  private static String sqliteUrl(String value) {
    String[] prefixes = {"sqlite:///", "sqlite://", "sqlite:"};
    String lower = value.toLowerCase(Locale.ROOT);
    for (String prefix : prefixes) {
      if (lower.startsWith(prefix)) {
        value = value.substring(prefix.length());
        break;
      }
    }
    // `sqlite:///C:/data/app.db` leaves a leading slash that belongs to the URL, not the
    // path, on Windows.
    if (value.length() > 2 && value.charAt(0) == '/' && value.charAt(2) == ':') {
      value = value.substring(1);
    }
    if (value.isEmpty()) {
      value = ":memory:";
    }
    return "jdbc:sqlite:" + value;
  }

  private static String postgresUrl(String value) {
    String lower = value.toLowerCase(Locale.ROOT);
    if (lower.startsWith("postgres://")) {
      return "jdbc:postgresql://" + value.substring("postgres://".length());
    }
    if (lower.startsWith("postgresql://")) {
      return "jdbc:postgresql://" + value.substring("postgresql://".length());
    }
    return null;
  }

  /**
   * SQL Server is reached either through a {@code jdbc:sqlserver:} URL, which is passed
   * through untouched, or through the ADO-style {@code Server=...;Database=...} string the
   * other adapters take.
   */
  private static String mssqlUrl(String value) {
    String lower = value.toLowerCase(Locale.ROOT);
    if (lower.startsWith("jdbc:")) {
      return value;
    }
    if (lower.startsWith("sqlserver://")) {
      value = value.substring("sqlserver://".length());
      lower = value.toLowerCase(Locale.ROOT);
    }

    String[] parts = value.split(";");
    String host = "";
    String port = "1433";
    String database = "";
    for (int i = 0; i < parts.length; i++) {
      String part = parts[i].trim();
      int at = part.indexOf('=');
      if (at < 0) {
        continue;
      }
      String key = part.substring(0, at).trim().toLowerCase(Locale.ROOT);
      String entry = part.substring(at + 1).trim();
      if (key.equals("server") || key.equals("data source") || key.equals("host") || key.equals("address")) {
        // ADO spells the port as a comma (`Server=db,1433`); a JDBC URL as a colon. Both
        // reach this function, so both separators have to be read.
        int colon = entry.lastIndexOf(':');
        int comma = entry.lastIndexOf(',');
        int portSeparator = Math.max(colon, comma);
        if (portSeparator > 0 && isNumeric(entry.substring(portSeparator + 1))) {
          host = entry.substring(0, portSeparator);
          port = entry.substring(portSeparator + 1);
        } else {
          host = entry;
        }
      } else if (key.equals("port")) {
        port = entry;
      } else if (key.equals("database") || key.equals("initial catalog")) {
        database = entry;
      }
    }
    if (host.isEmpty()) {
      return null;
    }
    String url = "jdbc:sqlserver://" + host + ":" + port;
    if (!database.isEmpty()) {
      url += ";databaseName=" + database;
    }
    return url + ";encrypt=true;trustServerCertificate=true";
  }

  /**
   * The username and password from a connection string, or {@code null} for either when
   * the string carries none — Windows integrated authentication has both absent.
   */
  public static String[] credentials(String connectionString) {
    if (connectionString == null) {
      return new String[] {null, null};
    }
    String user = null;
    String password = null;
    for (String part : connectionString.split(";")) {
      int separator = part.indexOf('=');
      if (separator < 0) {
        continue;
      }
      String key = part.substring(0, separator).trim().toLowerCase(Locale.ROOT);
      String value = part.substring(separator + 1).trim();
      if (key.equals("user") || key.equals("uid") || key.equals("user id")) {
        user = value;
      } else if (key.equals("password") || key.equals("pwd")) {
        password = value;
      }
    }
    return new String[] {user, password};
  }

  /**
   * The SQLite file path, or {@code null} for an in-memory database.
   *
   * <p>An in-memory database does not survive every connection being closed, so
   * {@code An5Adapter} keeps one connection open for exactly this case.
   */
  public static boolean isMemory(String connectionString) {
    if (connectionString == null) {
      return true;
    }
    String value = connectionString.trim().toLowerCase(Locale.ROOT);
    if (value.equals(":memory:")) {
      return true;
    }
    return value.contains("mode=memory") || value.startsWith("sqlite::memory:");
  }

  /** The connection properties for a username and password, either of which may be {@code null}. */
  public static Properties properties(String username, String password) {
    Properties properties = new Properties();
    if (username != null) {
      properties.setProperty("user", username);
    }
    if (password != null) {
      properties.setProperty("password", password);
    }
    return properties;
  }

  private static boolean isNumeric(String value) {
    if (value.isEmpty()) {
      return false;
    }
    for (int i = 0; i < value.length(); i++) {
      if (!Character.isDigit(value.charAt(i))) {
        return false;
      }
    }
    return true;
  }
}