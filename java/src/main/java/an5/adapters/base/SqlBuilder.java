package an5.adapters.base;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
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
              "equals",
              "in",
              "notIn",
              "contains",
              "startsWith",
              "endsWith",
              "not",
              "gte",
              "lte",
              "gt",
              "lt",
              "mode"));

  private static final Set<String> RELATION_MANY_KEYS =
      new HashSet<String>(Arrays.asList("some", "none", "every"));

  private static final Set<String> RELATION_ONE_KEYS =
      new HashSet<String>(Arrays.asList("is", "isNot", "is_not"));

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
   * Builds the {@code WHERE} clause for a filter tree without model relation metadata.
   *
   * <p>Every value reaches the database as a bind parameter; no value is ever formatted
   * into the SQL. {@code AND}/{@code OR}/{@code NOT} groups are supported, and an empty
   * {@code in: []} becomes {@code 1=0} rather than invalid {@code IN ()} SQL.
   */
  public static Where parseWhere(
      Map<String, ?> where, Dialect dialect, Map<String, Object> params, String prefix) {
    return parseWhere(where, dialect, params, prefix, null);
  }

  /**
   * Builds a model-aware {@code WHERE} clause with correlated {@code EXISTS} / {@code NOT EXISTS}
   * relation filters and strict operator validation.
   */
  public static Where parseWhere(
      Map<String, ?> where,
      Dialect dialect,
      Map<String, Object> params,
      String prefix,
      String modelName) {
    Map<String, Object> targetParams = params == null ? new LinkedHashMap<String, Object>() : params;
    if (where == null || where.isEmpty()) {
      return new Where("", targetParams);
    }
    String p = prefix == null ? "" : prefix;
    Map<String, Object> cleaned = cleanWhere(where, modelName);
    String sql = parseWhereRec(cleaned, dialect, targetParams, p, modelName, "", "");
    return new Where(sql, targetParams);
  }

  private static Map<String, Object> cleanWhere(Map<String, ?> where, String modelName) {
    boolean hasModel = modelName != null && !modelName.isEmpty();
    boolean hasFields = hasModel && Metadata.hasFields(modelName);
    Map<String, Object> flattened = new LinkedHashMap<String, Object>();
    for (Map.Entry<String, ?> entry : where.entrySet()) {
      String key = entry.getKey();
      Object value = entry.getValue();
      boolean compoundCandidate =
          key.indexOf('_') >= 0
              && (!hasModel
                  || (!Metadata.hasField(modelName, key)
                      && Metadata.relationFor(modelName, key) == null));
      if (compoundCandidate
          && value instanceof Map
          && !((Map<?, ?>) value).isEmpty()
          && !isOperatorValue(value)
          && !isRelationOperatorValue(value)
          && (!hasFields || allNestedFieldsKnown(modelName, (Map<?, ?>) value))) {
        for (Map.Entry<?, ?> nested : ((Map<?, ?>) value).entrySet()) {
          flattened.put(String.valueOf(nested.getKey()), nested.getValue());
        }
      } else {
        flattened.put(key, value);
      }
    }
    return flattened;
  }

  private static boolean allNestedFieldsKnown(String modelName, Map<?, ?> nested) {
    for (Object key : nested.keySet()) {
      if (!Metadata.hasField(modelName, String.valueOf(key))) {
        return false;
      }
    }
    return true;
  }

  private static String parseWhereRec(
      Map<String, ?> where,
      Dialect dialect,
      Map<String, Object> params,
      String prefix,
      String modelName,
      String selfRef,
      String colPrefix) {
    if (where == null || where.isEmpty()) {
      return "";
    }
    List<String> keys = new ArrayList<String>(where.keySet());
    Collections.sort(keys);
    List<String> conditions = new ArrayList<String>();

    for (String key : keys) {
      Object value = where.get(key);

      if ("OR".equals(key)) {
        if (!(value instanceof List)) {
          throw new IllegalArgumentException("'OR' filter must be a list of filter maps");
        }
        List<?> items = (List<?>) value;
        List<String> sub = new ArrayList<String>();
        for (int i = 0; i < items.size(); i++) {
          Object branch = items.get(i);
          if (!(branch instanceof Map)) {
            throw new IllegalArgumentException("'OR' branch must be a filter map");
          }
          Map<String, Object> branchMap = cleanWhere(copyMap(branch), modelName);
          sub.add(
              orEmpty(
                  parseWhereRec(
                      branchMap,
                      dialect,
                      params,
                      prefix + "or" + i + "_",
                      modelName,
                      selfRef,
                      colPrefix)));
        }
        conditions.add(sub.isEmpty() ? "1=0" : "(" + join(sub, " OR ") + ")");
      } else if ("AND".equals(key)) {
        List<Map<String, Object>> items = extractGroupMaps("AND", value);
        List<String> sub = new ArrayList<String>();
        for (int i = 0; i < items.size(); i++) {
          Map<String, Object> itemMap = cleanWhere(items.get(i), modelName);
          String sql =
              parseWhereRec(
                  itemMap,
                  dialect,
                  params,
                  prefix + "and" + i + "_",
                  modelName,
                  selfRef,
                  colPrefix);
          if (sql != null && !sql.isEmpty()) {
            sub.add(sql);
          }
        }
        if (!sub.isEmpty()) {
          conditions.add("(" + join(sub, " AND ") + ")");
        }
      } else if ("NOT".equals(key)) {
        List<Map<String, Object>> items = extractGroupMaps("NOT", value);
        List<String> sub = new ArrayList<String>();
        for (int i = 0; i < items.size(); i++) {
          Map<String, Object> itemMap = cleanWhere(items.get(i), modelName);
          sub.add(
              orEmpty(
                  parseWhereRec(
                      itemMap,
                      dialect,
                      params,
                      prefix + "not" + i + "_",
                      modelName,
                      selfRef,
                      colPrefix)));
        }
        if (!sub.isEmpty()) {
          conditions.add("NOT (" + join(sub, " OR ") + ")");
        }
      } else {
        RelationDef relation = Metadata.relationFor(modelName, key);
        if (relation != null) {
          String relSql =
              relationCondition(
                  modelName,
                  key,
                  relation,
                  value,
                  dialect,
                  params,
                  prefix + key + "_",
                  selfRef);
          if (!relSql.isEmpty()) {
            conditions.add(relSql);
          }
        } else {
          String sql =
              scalarCondition(
                  key, value, dialect, params, prefix, modelName, selfRef, colPrefix);
          if (!sql.isEmpty()) {
            conditions.add(sql);
          }
        }
      }
    }

    return join(conditions, " AND ");
  }

  private static String relationCondition(
      String modelName,
      String relationName,
      RelationDef relation,
      Object value,
      Dialect dialect,
      Map<String, Object> params,
      String relPrefix,
      String selfRef) {
    if (!(value instanceof Map)) {
      throw new IllegalArgumentException(
          "relation filter for '" + relationName + "' on '" + modelName + "' must be a map");
    }
    Map<?, ?> rawMap = (Map<?, ?>) value;
    boolean isMany = relation.isMany();
    Map<String, Object> normalized = new LinkedHashMap<String, Object>();

    List<String> rawOps = new ArrayList<String>();
    for (Object rawKey : rawMap.keySet()) {
      rawOps.add(String.valueOf(rawKey));
    }
    Collections.sort(rawOps);

    for (String rawOp : rawOps) {
      String canonical = "is_not".equals(rawOp) ? "isNot" : rawOp;
      boolean allowed =
          isMany
              ? RELATION_MANY_KEYS.contains(canonical)
              : ("is".equals(canonical) || "isNot".equals(canonical));
      if (!allowed) {
        throw new IllegalArgumentException(
            "unsupported relation filter operator '"
                + rawOp
                + "' for relation '"
                + relationName
                + "'");
      }
      normalized.put(canonical, rawMap.get(rawOp));
    }

    String childTable = quoteTable(Metadata.resolveTable(relation.modelName), dialect);
    String[] keys = Metadata.relationKeys(modelName, relation);
    String childCol = dialect.quoteIdentifier(keys[0]);
    String parentCol = dialect.quoteIdentifier(keys[1]);
    String parentRef =
        selfRef == null || selfRef.isEmpty()
            ? quoteTable(Metadata.resolveTable(modelName), dialect) + "."
            : selfRef + ".";

    List<String> parts = new ArrayList<String>();
    if (isMany) {
      String[] ops = {"some", "none", "every"};
      for (String op : ops) {
        if (!normalized.containsKey(op)) {
          continue;
        }
        Object rawInner = normalized.get(op);
        if (rawInner == null) {
          continue;
        }
        if (!(rawInner instanceof Map)) {
          throw new IllegalArgumentException(
              "'" + op + "' filter on relation '" + relationName + "' must be a map");
        }
        String alias = "r_" + sanitizeParamName(relPrefix + op + "_");
        String correlation = alias + "." + childCol + " = " + parentRef + parentCol;
        Map<String, Object> innerMap = cleanWhere(copyMap(rawInner), relation.modelName);
        String inner =
            parseWhereRec(
                innerMap,
                dialect,
                params,
                relPrefix + op + "_",
                relation.modelName,
                alias,
                alias + ".");
        if ("some".equals(op)) {
          String suffix = inner.isEmpty() ? "" : " AND (" + inner + ")";
          parts.add(
              "EXISTS (SELECT 1 FROM " + childTable + " AS " + alias + " WHERE " + correlation + suffix + ")");
        } else if ("none".equals(op)) {
          String suffix = inner.isEmpty() ? "" : " AND (" + inner + ")";
          parts.add(
              "NOT EXISTS (SELECT 1 FROM "
                  + childTable
                  + " AS "
                  + alias
                  + " WHERE "
                  + correlation
                  + suffix
                  + ")");
        } else {
          String violatedWhere = inner.isEmpty() ? " AND 1=0" : " AND NOT (" + inner + ")";
          parts.add(
              "NOT EXISTS (SELECT 1 FROM "
                  + childTable
                  + " AS "
                  + alias
                  + " WHERE "
                  + correlation
                  + violatedWhere
                  + ")");
        }
      }
    } else {
      if (normalized.containsKey("is")) {
        Object rawInner = normalized.get("is");
        String alias = "r_" + sanitizeParamName(relPrefix + "is_");
        String correlation = alias + "." + childCol + " = " + parentRef + parentCol;
        if (rawInner == null) {
          parts.add("NOT EXISTS (SELECT 1 FROM " + childTable + " AS " + alias + " WHERE " + correlation + ")");
        } else {
          if (!(rawInner instanceof Map)) {
            throw new IllegalArgumentException(
                "'is' filter on relation '" + relationName + "' must be a map or null");
          }
          Map<String, Object> innerMap = cleanWhere(copyMap(rawInner), relation.modelName);
          String inner =
              parseWhereRec(
                  innerMap,
                  dialect,
                  params,
                  relPrefix + "is_",
                  relation.modelName,
                  alias,
                  alias + ".");
          String suffix = inner.isEmpty() ? "" : " AND (" + inner + ")";
          parts.add(
              "EXISTS (SELECT 1 FROM " + childTable + " AS " + alias + " WHERE " + correlation + suffix + ")");
        }
      }
      if (normalized.containsKey("isNot")) {
        Object rawInner = normalized.get("isNot");
        String alias = "r_" + sanitizeParamName(relPrefix + "isNot_");
        String correlation = alias + "." + childCol + " = " + parentRef + parentCol;
        if (rawInner == null) {
          parts.add("EXISTS (SELECT 1 FROM " + childTable + " AS " + alias + " WHERE " + correlation + ")");
        } else {
          if (!(rawInner instanceof Map)) {
            throw new IllegalArgumentException(
                "'isNot' filter on relation '" + relationName + "' must be a map or null");
          }
          Map<String, Object> innerMap = cleanWhere(copyMap(rawInner), relation.modelName);
          String inner =
              parseWhereRec(
                  innerMap,
                  dialect,
                  params,
                  relPrefix + "isNot_",
                  relation.modelName,
                  alias,
                  alias + ".");
          String suffix = inner.isEmpty() ? "" : " AND (" + inner + ")";
          parts.add(
              "NOT EXISTS (SELECT 1 FROM "
                  + childTable
                  + " AS "
                  + alias
                  + " WHERE "
                  + correlation
                  + suffix
                  + ")");
        }
      }
    }

    return join(parts, " AND ");
  }

  private static String scalarCondition(
      String key,
      Object value,
      Dialect dialect,
      Map<String, Object> params,
      String prefix,
      String modelName,
      String selfRef,
      String colPrefix) {
    String column = colPrefix + dialect.quoteIdentifier(key);
    String paramName = sanitizeParamName(prefix + key);
    String placeholder = dialect.placeholder();

    if (value == null) {
      return column + " IS NULL";
    }
    if (!(value instanceof Map)) {
      putParam(params, paramName, value);
      return column + " = " + placeholder;
    }

    Map<?, ?> operators = (Map<?, ?>) value;
    List<String> opKeys = new ArrayList<String>();
    for (Object rawKey : operators.keySet()) {
      opKeys.add(String.valueOf(rawKey));
    }
    Collections.sort(opKeys);

    List<String> conditions = new ArrayList<String>();
    for (String op : opKeys) {
      Object operand = operators.get(op);
      if ("not".equals(op)) {
        if (operand == null) {
          conditions.add(column + " IS NOT NULL");
        } else if (operand instanceof Map) {
          String nestedSql =
              parseWhereRec(
                  single(key, operand),
                  dialect,
                  params,
                  prefix + key + "_not_",
                  modelName,
                  selfRef,
                  colPrefix);
          if (nestedSql != null && !nestedSql.isEmpty()) {
            conditions.add("NOT (" + nestedSql + ")");
          }
        } else {
          putParam(params, paramName + "_not", operand);
          conditions.add(column + " <> " + placeholder);
        }
      } else if ("equals".equals(op)) {
        if (operand == null) {
          conditions.add(column + " IS NULL");
        } else {
          putParam(params, paramName + "_eq", operand);
          conditions.add(column + " = " + placeholder);
        }
      } else if ("contains".equals(op)) {
        putParam(params, paramName + "_co", "%" + (operand == null ? "" : operand) + "%");
        conditions.add(column + " LIKE " + placeholder);
      } else if ("startsWith".equals(op)) {
        putParam(params, paramName + "_sw", (operand == null ? "" : operand) + "%");
        conditions.add(column + " LIKE " + placeholder);
      } else if ("endsWith".equals(op)) {
        putParam(params, paramName + "_ew", "%" + (operand == null ? "" : operand));
        conditions.add(column + " LIKE " + placeholder);
      } else if ("gte".equals(op)) {
        putParam(params, paramName + "_gte", operand);
        conditions.add(column + " >= " + placeholder);
      } else if ("lte".equals(op)) {
        putParam(params, paramName + "_lte", operand);
        conditions.add(column + " <= " + placeholder);
      } else if ("gt".equals(op)) {
        putParam(params, paramName + "_gt", operand);
        conditions.add(column + " > " + placeholder);
      } else if ("lt".equals(op)) {
        putParam(params, paramName + "_lt", operand);
        conditions.add(column + " < " + placeholder);
      } else if ("in".equals(op) || "notIn".equals(op)) {
        if (operand != null && !(operand instanceof Collection)) {
          throw new IllegalArgumentException("'" + op + "' operator for field '" + key + "' requires a list");
        }
        Collection<?> values =
            operand == null ? Collections.<Object>emptyList() : (Collection<?>) operand;
        boolean emptyIsFalse = "in".equals(op);
        if (values.isEmpty()) {
          // `IN ()` is a syntax error in every dialect. An empty set can match nothing, so it
          // becomes 1=0; the negated form is true of every row, so it becomes 1=1.
          conditions.add(emptyIsFalse ? "1=0" : "1=1");
        } else {
          List<String> placeholders = new ArrayList<String>();
          int idx = 0;
          for (Object item : values) {
            putParam(params, paramName + "_" + op + idx, item);
            placeholders.add(placeholder);
            idx++;
          }
          String sqlOp = emptyIsFalse ? " IN (" : " NOT IN (";
          conditions.add(column + sqlOp + join(placeholders, ", ") + ")");
        }
      } else if ("mode".equals(op)) {
        // Collation/case-sensitivity mode is accepted for parity across generated clients.
      } else {
        throw new IllegalArgumentException(
            "unsupported filter operator '" + op + "' for field '" + key + "'");
      }
    }

    return join(conditions, " AND ");
  }

  private static void putParam(Map<String, Object> params, String baseKey, Object value) {
    String candidate = baseKey;
    int suffix = 1;
    while (params.containsKey(candidate)) {
      candidate = baseKey + "_" + suffix;
      suffix++;
    }
    params.put(candidate, value);
  }

  private static List<Map<String, Object>> extractGroupMaps(String opName, Object value) {
    if (value instanceof List) {
      List<?> rawList = (List<?>) value;
      List<Map<String, Object>> items = new ArrayList<Map<String, Object>>(rawList.size());
      for (Object entry : rawList) {
        if (!(entry instanceof Map)) {
          throw new IllegalArgumentException("'" + opName + "' entry must be a filter map");
        }
        items.add(copyMap(entry));
      }
      return items;
    }
    if (value instanceof Map) {
      List<Map<String, Object>> singleItem = new ArrayList<Map<String, Object>>(1);
      singleItem.add(copyMap(value));
      return singleItem;
    }
    throw new IllegalArgumentException(
        "'" + opName + "' filter must be a filter map or list of filter maps");
  }

  private static Map<String, Object> copyMap(Object value) {
    Map<String, Object> copy = new LinkedHashMap<String, Object>();
    if (value instanceof Map) {
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
        copy.put(String.valueOf(entry.getKey()), entry.getValue());
      }
    }
    return copy;
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

  private static boolean isRelationOperatorValue(Object value) {
    if (!(value instanceof Map)) {
      return false;
    }
    for (Object key : ((Map<?, ?>) value).keySet()) {
      String k = String.valueOf(key);
      if (RELATION_MANY_KEYS.contains(k) || RELATION_ONE_KEYS.contains(k)) {
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