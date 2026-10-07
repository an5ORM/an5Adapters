package an5.adapters.base;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * SQLite vector search: the codec, the strategy plan and the ranking SQL.
 *
 * <p>SQLite has no vector type, so a {@code VECTOR(n)} column stores a BLOB of little-endian
 * float32 values (see {@link #encodeVector(double[])}) and is ranked in one of four ways, in
 * this order:
 *
 * <ol>
 *   <li>{@code sqlite-vec} — the extension, when it loads. Fastest, and the only option that
 *       can use an ANN index.
 *   <li>{@code udf} — {@code an5_vec_cosine} / {@code an5_vec_l2} / {@code an5_vec_ip}
 *       registered with the driver. Reads the BLOB and the legacy JSON text.
 *   <li>{@code sql} — {@code json_each} brute force in plain SQL. Needs no user function, so
 *       it works through plain JDBC, but only reaches rows stored as JSON text.
 *   <li>{@code memory} — the column is loaded and scored in Java.
 * </ol>
 *
 * <p>Strategies 1-3 rank inside the database and transfer only the matching rows, which is why
 * they are preferred over the in-memory path. JDBC has no API for registering a user function
 * or loading an extension, so a stock adapter reaches {@code sql} and {@code memory}: {@code
 * sqlite-vec} has to be loaded by the driver itself (the Xerial driver offers a {@code
 * _load_extension} connection property), and the UDFs need a driver built for it.
 *
 * <p>The docstring in the TypeScript {@code sqlite/vector.ts} is the shared specification every
 * runtime implements.
 */
public final class SqliteVectors {

  private SqliteVectors() {}

  /** The size of one stored value; a column's byte length is its dimension times this. */
  public static final int BYTES_PER_FLOAT = 4;

  public static final String STRATEGY_SQLITE_VEC = "sqlite-vec";
  public static final String STRATEGY_UDF = "udf";
  public static final String STRATEGY_SQL = "sql";
  public static final String STRATEGY_MEMORY = "memory";

  private static final Map<String, String> AN5_FUNCTIONS = new HashMap<String, String>();
  private static final Map<String, String> SQLITE_VEC_FUNCTIONS = new HashMap<String, String>();

  static {
    AN5_FUNCTIONS.put("cosine", "an5_vec_cosine");
    AN5_FUNCTIONS.put("euclidean", "an5_vec_l2");
    AN5_FUNCTIONS.put("dot", "an5_vec_ip");
    SQLITE_VEC_FUNCTIONS.put("cosine", "vec_distance_cosine");
    SQLITE_VEC_FUNCTIONS.put("euclidean", "vec_distance_l2");
    SQLITE_VEC_FUNCTIONS.put("dot", "vec_distance_ip");
  }

  /** The scalar functions the adapter registers itself. */
  public static Map<String, String> an5Functions() {
    return new HashMap<String, String>(AN5_FUNCTIONS);
  }

  /** The scalar functions the sqlite-vec extension provides. */
  public static Map<String, String> sqliteVecFunctions() {
    return new HashMap<String, String>(SQLITE_VEC_FUNCTIONS);
  }

  /** Returns a known metric name, defaulting to cosine. */
  public static String normalizeMetric(String metric) {
    if (metric == null) {
      return "cosine";
    }
    String lowered = metric.toLowerCase(Locale.ROOT);
    return "euclidean".equals(lowered) || "dot".equals(lowered) ? lowered : "cosine";
  }

  /** The function a strategy uses for a metric, or {@code null} when it has none. */
  public static String distanceFunction(String strategy, String metric) {
    Map<String, String> table;
    if (STRATEGY_SQLITE_VEC.equals(strategy)) {
      table = SQLITE_VEC_FUNCTIONS;
    } else if (STRATEGY_UDF.equals(strategy)) {
      table = AN5_FUNCTIONS;
    } else {
      return null;
    }
    return table.get(normalizeMetric(metric));
  }

  // ─── Codec ──────────────────────────────────────────────────────────────────────

  /** Encodes a vector as the little-endian float32 BLOB the column stores. */
  public static byte[] encodeVector(double[] values) {
    ByteBuffer buffer = ByteBuffer.allocate(values.length * BYTES_PER_FLOAT);
    buffer.order(ByteOrder.LITTLE_ENDIAN);
    for (double value : values) {
      buffer.putFloat((float) value);
    }
    return buffer.array();
  }

  /** True when the value still has to become bytes on its way into a column. */
  public static boolean needsVectorEncoding(Object value) {
    return value instanceof double[] || value instanceof float[] || value instanceof List;
  }

  /**
   * Decodes a stored vector: a float32 BLOB, a legacy JSON text column, or an array the
   * driver already decoded.
   *
   * @param expectedLength the query vector's length, or {@code 0} to accept any length
   */
  public static double[] decodeVector(Object value, int expectedLength) {
    if (value == null) {
      return null;
    }
    if (value instanceof byte[]) {
      return decodeVectorBytes((byte[]) value, expectedLength);
    }
    if (value instanceof double[]) {
      double[] copy = ((double[]) value).clone();
      return expectedLength > 0 && copy.length != expectedLength ? null : copy;
    }
    if (value instanceof float[]) {
      float[] source = (float[]) value;
      double[] copy = new double[source.length];
      for (int i = 0; i < source.length; i++) {
        copy[i] = source[i];
      }
      return expectedLength > 0 && copy.length != expectedLength ? null : copy;
    }
    if (value instanceof List) {
      List<?> items = (List<?>) value;
      double[] copy = new double[items.size()];
      for (int i = 0; i < items.size(); i++) {
        if (!(items.get(i) instanceof Number)) {
          return null;
        }
        copy[i] = ((Number) items.get(i)).doubleValue();
      }
      return expectedLength > 0 && copy.length != expectedLength ? null : copy;
    }
    // A column written by an older version holds JSON text, which Vectors already reads.
    return Vectors.parseVector(value, expectedLength);
  }

  /**
   * Decodes the float32 BLOB a {@code VECTOR(n)} column stores.
   *
   * <p>JSON text is not a multiple of four bytes once encoded and starts with {@code '['}, so
   * the two are told apart by length and first byte.
   */
  public static double[] decodeVectorBytes(byte[] bytes, int expectedLength) {
    if (bytes == null || bytes.length == 0) {
      return null;
    }
    if (bytes[0] == '[' || bytes.length % BYTES_PER_FLOAT != 0) {
      return Vectors.parseVector(new String(bytes, java.nio.charset.StandardCharsets.UTF_8),
          expectedLength);
    }
    ByteBuffer buffer = ByteBuffer.wrap(bytes);
    buffer.order(ByteOrder.LITTLE_ENDIAN);
    double[] values = new double[bytes.length / BYTES_PER_FLOAT];
    for (int i = 0; i < values.length; i++) {
      values[i] = buffer.getFloat();
    }
    if (expectedLength > 0 && values.length != expectedLength) {
      return null;
    }
    return values;
  }

  /** True when generated metadata describes a {@code VECTOR(n)} column. */
  public static boolean isVectorField(Object definition) {
    if (definition == null) {
      return false;
    }
    if (definition instanceof String) {
      String text = (String) definition;
      return text.contains("[]") || text.trim().toUpperCase(Locale.ROOT).startsWith("VECTOR");
    }
    if (definition instanceof Map) {
      Map<?, ?> record = (Map<?, ?>) definition;
      if ("vector".equals(record.get("kind"))) {
        return true;
      }
      for (String key : new String[] {"sql", "type"}) {
        Object sql = record.get(key);
        if (sql instanceof String && sqlLooksVector((String) sql)) {
          return true;
        }
      }
      Object ts = record.get("ts");
      return ts instanceof String && ((String) ts).contains("[]");
    }
    return false;
  }

  /** True when a declared SQL type names a vector column. */
  public static boolean sqlLooksVector(String sql) {
    String trimmed = sql.trim().toUpperCase(Locale.ROOT);
    if (!trimmed.startsWith("VECTOR")) {
      return false;
    }
    String rest = trimmed.substring("VECTOR".length());
    return rest.isEmpty() || rest.startsWith("(") || rest.startsWith(" ");
  }

  // ─── Strategy plan ───────────────────────────────────────────────────────────────

  /** What a connection can do, probed once and cached by the adapter. */
  public static final class Capabilities {
    /** {@code vec_version()} answered, so the sqlite-vec extension is loaded. */
    public boolean vec;
    /** The adapter's own distance functions are registered. */
    public boolean udf;
    /** {@code json_each()} is available, which the pure-SQL strategy needs. */
    public boolean json1;

    public Capabilities() {}

    public Capabilities(boolean vec, boolean udf, boolean json1) {
      this.vec = vec;
      this.udf = udf;
      this.json1 = json1;
    }
  }

  /**
   * The ordered strategies to try.
   *
   * <p>{@code declaredType} is the column's DDL type: the JSON strategy only reaches rows
   * stored as text, so a {@code BLOB} column drops it from the order.
   */
  public static List<String> planStrategies(
      Capabilities capabilities, String declaredType, String preference) {
    if (preference != null && !preference.isEmpty() && !"auto".equals(preference)) {
      // `memory` is the caller's own path, not a query, so it yields no plan.
      return "memory".equals(preference)
          ? new ArrayList<String>()
          : new ArrayList<String>(Arrays.asList(preference));
    }
    List<String> available = new ArrayList<String>();
    if (capabilities.vec) {
      available.add(STRATEGY_SQLITE_VEC);
    }
    if (capabilities.udf) {
      available.add(STRATEGY_UDF);
    }
    if (capabilities.json1) {
      available.add(STRATEGY_SQL);
    }
    String declared = declaredType == null ? "" : declaredType.trim().toUpperCase(Locale.ROOT);
    if (!declared.isEmpty()
        && !declared.contains("TEXT")
        && !declared.contains("CHAR")
        && !declared.contains("CLOB")
        && !declared.contains("STRING")
        && !declared.contains("JSON")) {
      // A BLOB column has no JSON to read, so json_each could only produce NULLs.
      available.remove(STRATEGY_SQL);
    }
    return available;
  }

  // ─── Query building ──────────────────────────────────────────────────────────────

  /** {@code json_valid} fails on a float32 BLOB, so the JSON path needs this guard. */
  private static String jsonText(String column) {
    return "CASE WHEN json_valid(" + column + ") THEN " + column + " ELSE '[]' END";
  }

  private static String jsonDistanceExpr(String metric, String column) {
    String row = jsonText(column);
    String sameLength = "(SELECT COUNT(*) FROM json_each(" + row + ")) = (SELECT COUNT(*) FROM q)";
    String terms;
    if ("euclidean".equals(metric)) {
      terms =
          "sqrt((SELECT SUM((je.value - q.v) * (je.value - q.v)) FROM json_each("
              + row
              + ") je JOIN q ON q.k = je.key))";
    } else if ("dot".equals(metric)) {
      terms =
          "-(SELECT SUM(je.value * q.v) FROM json_each(" + row + ") je JOIN q ON q.k = je.key)";
    } else {
      terms =
          "1.0 - (SELECT SUM(je.value * q.v) FROM json_each("
              + row
              + ") je JOIN q ON q.k = je.key)"
              + " / NULLIF(sqrt((SELECT SUM(q.v * q.v) FROM q)) * sqrt((SELECT SUM(je.value * je.value)"
              + " FROM json_each("
              + row
              + ") je)), 0)";
    }
    return "CASE WHEN " + sameLength + " THEN " + terms + " END";
  }

  /**
   * The ranking SQL for one strategy.
   *
   * <p>{@code sqlite-vec} and {@code udf} bind the query vector as a float32 BLOB; {@code sql}
   * binds it as JSON text because {@code json_each} reads text.
   *
   * <p>A row whose stored vector cannot be scored (a {@code NULL}, a text column, another
   * dimension) yields a {@code NULL} distance; those rows are dropped rather than reported, so
   * a caller never has to sort them out of the result.
   */
  public static String buildRankingQuery(
      String strategy,
      String metric,
      String table,
      String column,
      double[] vector,
      int take,
      String tail,
      String placeholder,
      List<Object> bind) {
    String normalized = normalizeMetric(metric);
    String inner;
    if (STRATEGY_SQLITE_VEC.equals(strategy) || STRATEGY_UDF.equals(strategy)) {
      String function = distanceFunction(strategy, normalized);
      if (function == null) {
        return null;
      }
      String distance = function + "(" + column + ", " + placeholder + ")";
      String guard = "";
      if (STRATEGY_SQLITE_VEC.equals(strategy)) {
        // sqlite-vec only understands float32 BLOB operands, so rows stored any other way are
        // excluded instead of aborting the query. The guard joins the caller's WHERE with AND,
        // since appending the tail after it would produce a second WHERE.
        guard = "typeof(" + column + ") = 'blob' AND length(" + column + ") = " + placeholder;
        bind.add(encodeVector(vector));
        bind.add(Integer.valueOf(vector.length * BYTES_PER_FLOAT));
      } else {
        bind.add(encodeVector(vector));
      }
      if (guard.isEmpty()) {
        inner = "SELECT *, " + distance + " AS distance FROM " + table + tail;
      } else if (tail.isEmpty()) {
        inner = "SELECT *, " + distance + " AS distance FROM " + table + " WHERE " + guard;
      } else {
        inner =
            "SELECT *, "
                + distance
                + " AS distance FROM "
                + table
                + " WHERE "
                + guard
                + " AND"
                + tail.replaceFirst("(?i)\\s+WHERE\\s+", " ");
      }
    } else {
      bind.add(Vectors.formatVector(vector));
      inner =
          "SELECT *, "
              + jsonDistanceExpr(normalized, column)
              + " AS distance FROM "
              + table
              + tail;
      inner =
          "WITH q AS (SELECT je.key AS k, CAST(je.value AS REAL) AS v FROM json_each("
              + placeholder
              + ") je) "
              + inner;
    }
    return "SELECT * FROM ("
        + inner
        + ") AS an5_ranked WHERE distance IS NOT NULL ORDER BY distance ASC LIMIT "
        + take;
  }
}
