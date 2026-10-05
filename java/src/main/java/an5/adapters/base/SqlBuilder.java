package an5.adapters.base;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Turns a where/order-by tree into SQL and the bind values that go with it. */
public final class SqlBuilder {

  private static final Set<String> OPERATOR_KEYS =
      new HashSet<String>(
          Arrays.asList(
              "equals", "in", "notIn", "contains", "startsWith", "endsWith", "not", "gte", "lte", "gt", "lt"));

  private SqlBuilder() {}

  /** Where parameters in bind order, with the SQL that reads them. */
  public static final class Where {
    public final String sql;
    public final List<Object> params;

    Where(String sql, Map<String, Object> params) {
      this.sql = sql;
      this.params = new ArrayList<Object>(params.values());
    }

    public boolean isEmpty() {
      return sql == null || sql.isEmpty();
    }
  }

  /**
   * Builds the {@code WHERE} clause for a filter tree.
   *
   * <p>Every value reaches the database as a bind parameter; no value is ever formatted
   * into the SQL. {@code AND}/{@code OR}/{@code NOT} groups are supported, and an empty
   * {@code in: []} becomes {@code 1=0} rather than invalid {@code IN ()} SQL.
   */
  public static Where parseWhere(
      Map<String, ?> where, Dialect dialect, Map<String, Object> params, String prefix) {
    if (where == null || where.isEmpty()) {
      return new Where("", params);
    }
    String p = prefix == null ? "" : prefix;
    List<String> conditions = new ArrayList<String>();

    Map<String, Object> flattened = new LinkedHashMap<String, Object>();
    for (Map.Entry<String, ?> entry : where.entrySet()) {
      String key = entry.getKey();
      Object value = entry.getValue();
      if (key.indexOf('_') >= 0 && value instanceof Map && !isOperatorValue(value)) {
        for (Map.Entry<?, ?> nested : ((Map<?, ?>) value).entrySet()) {
          flattened.put(String.valueOf(nested.getKey()), nested.getValue());
        }
      } else {
        flattened.put(key, value);
      }
    }

    for (Map.Entry<String, Object> entry : flattened.entrySet()) {
      String key = entry.getKey();
      Object value = entry.getValue();

      if ("OR".equals(key) && value instanceof List) {
        List<?> items = (List<?>) value;
        List<String> sub = new ArrayList<String>();
        for (int i = 0; i < items.size(); i++) {
          sub.add(orEmpty(parseWhere(asMap(items.get(i)), dialect, params, p + "or" + i + "_").sql));
        }
        conditions.add(sub.isEmpty() ? "1=0" : "(" + join(sub, " OR ") + ")");
      } else if ("AND".equals(key)) {
        List<?> items = value instanceof List ? (List<?>) value : one(value);
        List<String> sub = new ArrayList<String>();
        for (int i = 0; i < items.size(); i++) {
          String sql = parseWhere(asMap(items.get(i)), dialect, params, p + "and" + i + "_").sql;
          if (sql != null && !sql.isEmpty()) {
            sub.add(sql);
          }
        }
        if (!sub.isEmpty()) {
          conditions.add("(" + join(sub, " AND ") + ")");
        }
      } else if ("NOT".equals(key)) {
        List<?> items = value instanceof List ? (List<?>) value : one(value);
        List<String> sub = new ArrayList<String>();
        for (int i = 0; i < items.size(); i++) {
          sub.add(orEmpty(parseWhere(asMap(items.get(i)), dialect, params, p + "not" + i + "_").sql));
        }
        if (!sub.isEmpty()) {
          conditions.add("NOT (" + join(sub, " OR ") + ")");
        }
      } else {
        String column = dialect.quoteIdentifier(key);
        String paramName = sanitizeParamName(p + key);
        String placeholder = dialect.placeholder();

        if (value == null) {
          conditions.add(column + " IS NULL");
        } else if (value instanceof Map) {
          for (String condition : operators((Map<?, ?>) value, key, column, paramName, dialect, params, p)) {
            conditions.add(condition);
          }
        } else {
          params.put(paramName, value);
          conditions.add(column + " = " + placeholder);
        }
      }
    }

    return new Where(join(conditions, " AND "), params);
  }

  private static List<String> operators(
      Map<?, ?> value,
      String key,
      String column,
      String paramName,
      Dialect dialect,
      Map<String, Object> params,
      String prefix) {
    List<String> conditions = new ArrayList<String>();
    String placeholder = dialect.placeholder();

    if (value.containsKey("not")) {
      Object inner = value.get("not");
      if (inner == null) {
        conditions.add(column + " IS NOT NULL");
      } else if (inner instanceof Map) {
        Map<String, Object> nestedParams = new LinkedHashMap<String, Object>();
        String nestedSql =
            parseWhere(
                    single(key, inner), dialect, nestedParams, prefix + key + "_not_").sql;
        params.putAll(nestedParams);
        if (nestedSql != null && !nestedSql.isEmpty()) {
          conditions.add("NOT (" + nestedSql + ")");
        }
      } else {
        params.put(paramName + "_not", inner);
        conditions.add(column + " <> " + placeholder);
      }
    }
    if (value.containsKey("equals")) {
      Object equals = value.get("equals");
      if (equals == null) {
        conditions.add(column + " IS NULL");
      } else {
        params.put(paramName + "_eq", equals);
        conditions.add(column + " = " + placeholder);
      }
    }
    String[][] like = {
      {"contains", "%%%s%%", "_co"},
      {"startsWith", "%s%%", "_sw"},
      {"endsWith", "%%%s", "_ew"},
    };
    for (String[] entry : like) {
      if (!value.containsKey(entry[0])) {
        continue;
      }
      Object operand = value.get(entry[0]);
      params.put(
          paramName + entry[2],
          String.format(Locale.ROOT, entry[1], operand == null ? "" : operand));
      conditions.add(column + " LIKE " + placeholder);
    }
    addComparison(conditions, value, "gte", params, paramName, column, placeholder, ">=");
    addComparison(conditions, value, "lte", params, paramName, column, placeholder, "<=");
    addComparison(conditions, value, "gt", params, paramName, column, placeholder, ">");
    addComparison(conditions, value, "lt", params, paramName, column, placeholder, "<");

    addSet(conditions, value, "in", params, paramName, column, placeholder, " IN (", true);
    addSet(conditions, value, "notIn", params, paramName, column, placeholder, " NOT IN (", false);

    return conditions;
  }

  private static void addComparison(
      List<String> conditions,
      Map<?, ?> value,
      String operator,
      Map<String, Object> params,
      String paramName,
      String column,
      String placeholder,
      String sql) {
    if (!value.containsKey(operator)) {
      return;
    }
    params.put(paramName + "_" + operator, value.get(operator));
    conditions.add(column + " " + sql + " " + placeholder);
  }

  private static void addSet(
      List<String> conditions,
      Map<?, ?> value,
      String operator,
      Map<String, Object> params,
      String paramName,
      String column,
      String placeholder,
      String sql,
      boolean emptyIsFalse) {
    if (!value.containsKey(operator)) {
      return;
    }
    Object raw = value.get(operator);
    List<?> values = raw instanceof List ? (List<?>) raw : raw == null ? new ArrayList<Object>() : one(raw);
    if (values.isEmpty()) {
      // `IN ()` is a syntax error in every dialect. An empty set can match nothing, so it
      // becomes 1=0; the negated form is true of every row, so it becomes 1=1.
      conditions.add(emptyIsFalse ? "1=0" : "1=1");
      return;
    }
    List<String> placeholders = new ArrayList<String>();
    for (int i = 0; i < values.size(); i++) {
      params.put(paramName + "_" + operator + i, values.get(i));
      placeholders.add(placeholder);
    }
    conditions.add(column + sql + join(placeholders, ", ") + ")");
  }

  /** Builds the {@code ORDER BY} clause from either a single map or a list of maps. */
  public static String buildOrderBy(Object orderBy, Dialect dialect) {
    if (orderBy == null) {
      return "";
    }
    List<?> entries = orderBy instanceof List ? (List<?>) orderBy : one(orderBy);
    List<String> parts = new ArrayList<String>();
    for (Object entry : entries) {
      if (!(entry instanceof Map)) {
        continue;
      }
      for (Map.Entry<?, ?> field : ((Map<?, ?>) entry).entrySet()) {
        String direction = field.getValue() == null ? "" : String.valueOf(field.getValue());
        parts.add(
            dialect.quoteIdentifier(String.valueOf(field.getKey()))
                + ("DESC".equalsIgnoreCase(direction) ? " DESC" : " ASC"));
      }
    }
    return parts.isEmpty() ? "" : "ORDER BY " + join(parts, ", ");
  }

  /** Appends one {@code SET} assignment, expanding the arithmetic update operators. */
  public static void appendUpdateSet(
      List<String> setParts,
      List<Object> values,
      String column,
      Object value,
      Dialect dialect) {
    String quoted = dialect.quoteIdentifier(column);
    String placeholder = dialect.placeholder();
    if (value instanceof Map) {
      Map<?, ?> operations = (Map<?, ?>) value;
      String[][] arithmetic =
          new String[][] {
            {"increment", "+"}, {"decrement", "-"}, {"multiply", "*"}, {"divide", "/"}
          };
      for (String[] pair : arithmetic) {
        if (operations.containsKey(pair[0])) {
          setParts.add(quoted + " = " + quoted + " " + pair[1] + " " + placeholder);
          values.add(operations.get(pair[0]));
          return;
        }
      }
      if (operations.containsKey("set")) {
        setParts.add(quoted + " = " + placeholder);
        values.add(operations.get("set"));
        return;
      }
    }
    setParts.add(quoted + " = " + placeholder);
    values.add(value);
  }

  /**
   * Quotes a possibly schema-qualified table name.
   *
   * <p>An already-bracketed name is never returned as-is: that quoting is only correct on
   * MSSQL, so the brackets are stripped and re-applied for the target dialect instead of
   * letting one dialect's quoting follow the name into another.
   */
  public static String quoteTable(String table, Dialect dialect) {
    List<String> parts = splitQualified(table);
    if (dialect == Dialect.SQLITE
        && parts.size() == 2
        && unquote(parts.get(0)).toLowerCase(Locale.ROOT).equals("dbo")) {
      parts = parts.subList(1, parts.size());
    }
    if (parts.isEmpty()) {
      parts = new ArrayList<String>();
      parts.add(table == null ? "" : table);
    }
    List<String> quoted = new ArrayList<String>();
    for (String part : parts) {
      quoted.add(dialect.quoteIdentifier(part));
    }
    return join(quoted, ".");
  }

  /**
   * Splits {@code schema.table} without cutting a dot inside brackets or quotes.
   *
   * <p>A plain split on {@code "."} turns {@code [dbo].[users]} into two bracketed parts
   * only for MSSQL; the other dialects need the brackets removed before re-quoting.
   */
  private static List<String> splitQualified(String table) {
    List<String> parts = new ArrayList<String>();
    StringBuilder buffer = new StringBuilder();
    char open = 0;
    char close = 0;
    for (int i = 0; i < table.length(); i++) {
      char ch = table.charAt(i);
      if (open != 0) {
        buffer.append(ch);
        if (ch == close) {
          open = 0;
          close = 0;
        }
        continue;
      }
      if (ch == '[' || ch == '"') {
        open = ch;
        close = ch == '[' ? ']' : '"';
        buffer.append(ch);
        continue;
      }
      if (ch == '.') {
        parts.add(buffer.toString());
        buffer.setLength(0);
        continue;
      }
      buffer.append(ch);
    }
    parts.add(buffer.toString());

    List<String> kept = new ArrayList<String>();
    for (String part : parts) {
      if (!part.isEmpty()) {
        kept.add(part);
      }
    }
    return kept;
  }

  private static String unquote(String name) {
    String value = name;
    if (value.length() >= 2 && value.startsWith("[") && value.endsWith("]")) {
      value = value.substring(1, value.length() - 1);
    }
    if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
      value = value.substring(1, value.length() - 1);
    }
    return value;
  }

  /** A bind parameter name that is a legal identifier in every dialect. */
  public static String sanitizeParamName(String name) {
    StringBuilder cleaned = new StringBuilder();
    for (int i = 0; i < name.length(); i++) {
      char ch = name.charAt(i);
      cleaned.append(Character.isLetterOrDigit(ch) || ch == '_' ? ch : '_');
    }
    String value = cleaned.toString();
    if (value.isEmpty() || !Character.isLetter(value.charAt(0))) {
      return "p_" + value;
    }
    return value;
  }

  private static boolean isOperatorValue(Object value) {
    if (!(value instanceof Map)) {
      return false;
    }
    for (Object key : ((Map<?, ?>) value).keySet()) {
      if (OPERATOR_KEYS.contains(String.valueOf(key))) {
        return true;
      }
    }
    return false;
  }

  private static Map<String, Object> single(String key, Object value) {
    Map<String, Object> map = new LinkedHashMap<String, Object>();
    map.put(key, value);
    return map;
  }

  private static Map<String, ?> asMap(Object value) {
    if (value instanceof Map) {
      @SuppressWarnings("unchecked")
      Map<String, Object> cast = (Map<String, Object>) value;
      return cast;
    }
    return new LinkedHashMap<String, Object>();
  }

  private static List<Object> one(Object value) {
    List<Object> list = new ArrayList<Object>();
    list.add(value);
    return list;
  }

  private static String orEmpty(String sql) {
    return sql == null || sql.isEmpty() ? "1=1" : sql;
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