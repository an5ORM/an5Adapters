package an5.adapters.base;

import java.util.Locale;

/**
 * The database dialects AN5 speaks, together with everything that differs between them.
 *
 * <p>The differences are not cosmetic. Quoting, pagination and the {@code WITH (NOLOCK)}
 * hint each have to be produced per dialect, and getting one wrong yields SQL the target
 * engine cannot parse — so all of it is decided here rather than at each call site.
 */
public enum Dialect {
  MSSQL("mssql"),
  POSTGRES("postgres"),
  SQLITE("sqlite");

  private final String id;

  Dialect(String id) {
    this.id = id;
  }

  /** The lower-case identifier used in connection strings and generated metadata. */
  public String id() {
    return id;
  }

  /**
   * The dialect a connection string points at.
   *
   * <p>Lower-cased first: a URI scheme is case-insensitive, so {@code MySQL://} and
   * {@code mysql://} are the same connection.
   */
  public static Dialect detect(String connectionString) {
    String cs = connectionString == null ? "" : connectionString.trim().toLowerCase(Locale.ROOT);
    if (cs.startsWith("postgres://") || cs.startsWith("postgresql://")) {
      return POSTGRES;
    }
    if (cs.startsWith("sqlite://")
        || cs.startsWith("sqlite:")
        || cs.startsWith("file:")
        || cs.endsWith(".db")
        || cs.endsWith(".sqlite")
        || cs.endsWith(".sqlite3")
        || cs.equals(":memory:")) {
      return SQLITE;
    }
    return MSSQL;
  }

  /**
   * The JDBC bind placeholder.
   *
   * <p>Always {@code ?}: every JDBC driver binds positionally. PostgreSQL's {@code %s} is
   * a psycopg2-only spelling, so the other adapters' dialect split does not carry over.
   */
  public String placeholder() {
    return "?";
  }

  /** Quotes a bare column or identifier name for this dialect. */
  public String quoteIdentifier(String name) {
    String raw = stripWrapping(name, "[", "]");
    if (this == MSSQL) {
      return "[" + raw.replace("]", "]]") + "]";
    }
    String unwrapped = stripWrapping(raw, "\"", "\"");
    return "\"" + unwrapped.replace("\"", "\"\"") + "\"";
  }

  /** {@code WITH (NOLOCK)} is an MSSQL table hint; no other dialect has an equivalent. */
  public boolean supportsNolock() {
    return this == MSSQL;
  }

  /**
   * The trailing limit clause.
   *
   * <p>SQLite has {@code LIMIT ... OFFSET} like PostgreSQL. Emitting the MSSQL
   * {@code OFFSET ... FETCH NEXT} form against SQLite produces SQL it cannot parse, so
   * the two are kept apart deliberately.
   */
  public String pagination(Integer take, int skip, String orderSql) {
    if (take == null) {
      return "";
    }
    if (this == MSSQL) {
      String prefix = orderSql == null || orderSql.isEmpty() ? " ORDER BY (SELECT NULL)" : "";
      return prefix + " OFFSET " + Math.max(0, skip) + " ROWS FETCH NEXT " + take + " ROWS ONLY";
    }
    return " LIMIT " + take + " OFFSET " + Math.max(0, skip);
  }

  private static String stripWrapping(String name, String left, String right) {
    String value = name == null ? "" : String.valueOf(name);
    if (value.length() >= left.length() + right.length()
        && value.startsWith(left)
        && value.endsWith(right)) {
      return value.substring(left.length(), value.length() - right.length());
    }
    return value;
  }
}