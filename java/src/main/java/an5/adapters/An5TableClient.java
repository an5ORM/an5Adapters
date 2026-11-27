package an5.adapters;

import an5.adapters.base.Dialect;
import an5.adapters.base.FieldMeta;
import an5.adapters.base.Metadata;
import an5.adapters.base.RelationDef;
import an5.adapters.base.SqlBuilder;
import an5.adapters.base.SqliteVectors;
import an5.adapters.base.Vectors;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * CRUD and queries for one table, driven entirely by the registered metadata.
 *
 * <p>Rows come back as {@code Map<String, Object>} keyed by column label. The generated
 * client wraps them in its own model types, so this class stays independent of the schema
 * and of the generator — the same reason the other adapters' table clients work on
 * untyped rows.
 */
public class An5TableClient {

  private final An5Adapter adapter;
  private final String modelName;
  private final Dialect dialect;

  public An5TableClient(An5Adapter adapter, String modelName) {
    this.adapter = adapter;
    this.modelName = modelName;
    this.dialect = adapter.dialect();
  }

  public String modelName() {
    return modelName;
  }

  private String tableSql() {
    return SqlBuilder.quoteTable(Metadata.resolveTable(modelName), dialect);
  }

  /** {@code WITH (NOLOCK)} is an MSSQL hint; leaving it in makes every other dialect fail. */
  private String nolock() {
    return dialect.supportsNolock() ? " WITH (NOLOCK)" : "";
  }

  private List<FieldMeta> fields() {
    return Metadata.fieldsFor(modelName);
  }

  /** The {@code VECTOR(n)} columns of this model, from the generated metadata. */
  private List<String> vectorFields() {
    List<String> names = new ArrayList<String>();
    for (FieldMeta field : fields()) {
      if (SqliteVectors.isVectorField(field.sqlType) || SqliteVectors.isVectorField(field.type)) {
        names.add(field.name);
      }
    }
    return names;
  }

  /**
   * Encodes every {@code VECTOR(n)} value on its way into SQLite.
   *
   * <p>The column holds a float32 BLOB, which is a third of the size of the JSON text it
   * replaces. Values that already arrived as text or bytes are left alone, so rows written by
   * an older version stay readable.
   */
  private Map<String, Object> encodeVectorFields(Map<String, Object> data) {
    if (dialect != Dialect.SQLITE) {
      return data;
    }
    List<String> names = vectorFields();
    if (names.isEmpty()) {
      return data;
    }
    Map<String, Object> out = new LinkedHashMap<String, Object>(data);
    for (String name : names) {
      Object value = out.get(name);
      if (!SqliteVectors.needsVectorEncoding(value)) {
        continue;
      }
      double[] decoded = SqliteVectors.decodeVector(value, 0);
      if (decoded != null) {
        out.put(name, SqliteVectors.encodeVector(decoded));
      }
    }
    return out;
  }

  /** Decodes {@code VECTOR(n)} columns back into arrays of numbers after a read. */
  private List<Map<String, Object>> decodeVectorRows(List<Map<String, Object>> rows) {
    if (dialect != Dialect.SQLITE || rows.isEmpty()) {
      return rows;
    }
    List<String> names = vectorFields();
    if (names.isEmpty()) {
      return rows;
    }
    for (Map<String, Object> row : rows) {
      for (String name : names) {
        if (!row.containsKey(name)) {
          continue;
        }
        double[] decoded = SqliteVectors.decodeVector(row.get(name), 0);
        if (decoded != null) {
          row.put(name, decoded);
        }
      }
    }
    return rows;
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────────

  public List<Map<String, Object>> findMany() throws SQLException {
    return findMany(new An5Query());
  }

  public List<Map<String, Object>> findMany(An5Query query) throws SQLException {
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(query.whereMap(), dialect, params, "", modelName);
    String orderSql = SqlBuilder.buildOrderBy(query.orderByValue(), dialect);

    Map<String, RelationDef> relations = Metadata.relationsFor(modelName);
    List<String> selected = query.selectValue();
    boolean hasInclude = !collectIncludeKeys(query.includeValue()).isEmpty();
    String columns = "SELECT *";
    if (selected != null && !selected.isEmpty() && !hasRelationSelect(selected, relations) && !hasInclude) {
      columns = "SELECT " + quoteAll(selected);
    }

    StringBuilder sql = new StringBuilder(columns);
    sql.append(" FROM ").append(tableSql()).append(nolock());
    if (!where.isEmpty()) {
      sql.append(" WHERE ").append(where.sql);
    }
    if (!orderSql.isEmpty()) {
      sql.append(' ').append(orderSql);
    }
    sql.append(dialect.pagination(query.takeValue(), query.skipValue(), orderSql));

    List<Map<String, Object>> rows = adapter.exec(sql.toString(), where.params);
    if (hasInclude) {
      resolveIncludes(modelName, relations, rows, query.includeValue());
    }
    if (selected != null) {
      if (hasRelationSelect(selected, relations)) {
        resolveIncludes(modelName, relations, rows, relationSelect(selected, relations));
      }
      rows = projectFields(rows, selected, collectIncludeKeys(query.includeValue()));
    }
    return decodeVectorRows(rows);
  }

  /** The first matching row, or {@code null}. Always limited to one row server-side. */
  public Map<String, Object> findFirst(An5Query query) throws SQLException {
    List<Map<String, Object>> rows = findMany(limitedTo(query, 1));
    return rows.isEmpty() ? null : rows.get(0);
  }

  public Map<String, Object> findFirst(Map<String, Object> where) throws SQLException {
    return findFirst(new An5Query().where(where));
  }

  public Map<String, Object> findUnique(An5Query query) throws SQLException {
    return findFirst(query);
  }

  public Map<String, Object> findUnique(Map<String, Object> where) throws SQLException {
    return findFirst(where);
  }

  /** How many rows match. */
  public long count() throws SQLException {
    return count(null);
  }

  public long count(Map<String, Object> where) throws SQLException {
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "", modelName);
    StringBuilder sql =
        new StringBuilder("SELECT COUNT(*) AS cnt FROM ").append(tableSql()).append(nolock());
    if (!clause.isEmpty()) {
      sql.append(" WHERE ").append(clause.sql);
    }
    List<Map<String, Object>> rows = adapter.exec(sql.toString(), clause.params);
    if (rows.isEmpty()) {
      return 0;
    }
    Object value = rows.get(0).values().iterator().next();
    return value instanceof Number ? ((Number) value).longValue() : 0;
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────────

  /**
   * Inserts a row and returns it, re-reading it so server-side defaults and generated
   * columns come back with the result.
   *
   * <p>A model with an {@code @id} column and no value for it gets a fresh UUID, which is
   * what makes a client-created row addressable without a database-side default.
   */
  public Map<String, Object> create(Map<String, Object> data) throws SQLException {
    return create(data, new An5Query());
  }

  public Map<String, Object> create(Map<String, Object> data, An5Query query) throws SQLException {
    Map<String, Object> relationWrites = splitRelationWrites(data);
    Map<String, Object> scalars = withoutRelations(data);

    FieldMeta idField = FieldMeta.idField(fields());
    if (idField != null && !scalars.containsKey(idField.name)) {
      scalars.put(idField.name, UUID.randomUUID().toString());
    }
    scalars = encodeVectorFields(scalars);

    List<String> columns = new ArrayList<String>();
    List<Object> values = new ArrayList<Object>();
    for (Map.Entry<String, Object> entry : scalars.entrySet()) {
      // A null column is left out rather than bound as NULL: an unset column takes the
      // schema's DEFAULT, which is what the caller meant by leaving it out.
      if (entry.getValue() != null) {
        columns.add(entry.getKey());
        values.add(entry.getValue());
      }
    }

    if (!columns.isEmpty()) {
      List<String> placeholders = new ArrayList<String>();
      for (int i = 0; i < columns.size(); i++) {
        placeholders.add(dialect.placeholder());
      }
      adapter.execute(
          "INSERT INTO "
              + tableSql()
              + " ("
              + quoteAll(columns)
              + ") VALUES ("
              + join(placeholders, ", ")
              + ")",
          values);
    }

    Map<String, Object> created = scalars;
    if (idField != null) {
      Map<String, Object> found =
          findFirst(new An5Query().where(single(idField.name, scalars.get(idField.name))));
      if (found != null) {
        created = found;
      }
    }

    applyRelationCreates(created, relationWrites);
    return projectAfterWrite(created, query);
  }

  /**
   * Inserts many rows, one statement each.
   *
   * <p>Row-at-a-time on purpose: a batch would share one parameter list, so a single bad row
   * would lose every good row with it, and {@code skipDuplicates} has no meaning for a batch.
   */
  public Map<String, Object> createMany(List<Map<String, Object>> rows, boolean skipDuplicates)
      throws SQLException {
    int count = 0;
    for (Map<String, Object> row : rows) {
      try {
        create(row);
        count++;
      } catch (SQLException error) {
        if (!skipDuplicates) {
          throw error;
        }
      }
    }
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("count", count);
    return result;
  }

  /** Updates the rows matching {@code query.where} and returns the first of them re-read. */
  public Map<String, Object> update(An5Query query, Map<String, Object> data) throws SQLException {
    return update(query, data, new An5Query());
  }

  /**
   * Updates the rows matching {@code query.where}, then applies {@code options} to the result.
   *
   * <p>The filter and the returned projection are separate arguments on purpose: a caller
   * that wants the updated row's relations must still say which rows to update, and folding
   * the two into one object makes it possible to project without filtering.
   */
  public Map<String, Object> update(An5Query query, Map<String, Object> data, An5Query options)
      throws SQLException {
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(query.whereMap(), dialect, params, "w_", modelName);

    Map<String, Object> relationWrites = splitRelationWrites(data);
    Map<String, Object> scalars = withoutRelations(data);

    scalars = encodeVectorFields(scalars);
    List<String> setParts = new ArrayList<String>();
    List<Object> setValues = new ArrayList<Object>();
    for (Map.Entry<String, Object> entry : scalars.entrySet()) {
      if (entry.getValue() != null) {
        SqlBuilder.appendUpdateSet(setParts, setValues, entry.getKey(), entry.getValue(), dialect);
      }
    }

    if (!setParts.isEmpty()) {
      List<Object> allValues = new ArrayList<Object>(setValues);
      allValues.addAll(where.params);
      StringBuilder sql =
          new StringBuilder("UPDATE ").append(tableSql()).append(" SET ").append(join(setParts, ", "));
      if (!where.isEmpty()) {
        sql.append(" WHERE ").append(where.sql);
      }
      adapter.execute(sql.toString(), allValues);
    }

    Map<String, Object> updated = findFirst(query);
    applyRelationUpdates(updated, query.whereMap(), relationWrites);
    return projectAfterWrite(updated, options);
  }

  public Map<String, Object> update(Map<String, Object> where, Map<String, Object> data)
      throws SQLException {
    return update(new An5Query().where(where), data);
  }

  /** Updates every matching row and gives back how many changed. */
  public Map<String, Object> updateMany(Map<String, Object> where, Map<String, Object> data)
      throws SQLException {
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "w_", modelName);

    Map<String, Object> encoded = encodeVectorFields(data);
    List<String> setParts = new ArrayList<String>();
    List<Object> setValues = new ArrayList<Object>();
    for (Map.Entry<String, Object> entry : encoded.entrySet()) {
      if (entry.getValue() != null) {
        SqlBuilder.appendUpdateSet(setParts, setValues, entry.getKey(), entry.getValue(), dialect);
      }
    }

    Map<String, Object> result = new LinkedHashMap<String, Object>();
    if (setParts.isEmpty()) {
      result.put("count", 0);
      return result;
    }

    List<Object> allValues = new ArrayList<Object>(setValues);
    allValues.addAll(clause.params);
    StringBuilder sql =
        new StringBuilder("UPDATE ").append(tableSql()).append(" SET ").append(join(setParts, ", "));
    if (!clause.isEmpty()) {
      sql.append(" WHERE ").append(clause.sql);
    }
    result.put("count", adapter.execute(sql.toString(), allValues));
    return result;
  }

  /** Deletes the matching rows and returns the one that was there first. */
  public Map<String, Object> delete(Map<String, Object> where) throws SQLException {
    Map<String, Object> existing = findFirst(where);
    deleteMany(where);
    return existing;
  }

  /** Deletes every matching row, or the whole table when {@code where} is {@code null}. */
  public Map<String, Object> deleteMany(Map<String, Object> where) throws SQLException {
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "", modelName);
    StringBuilder sql = new StringBuilder("DELETE FROM ").append(tableSql());
    if (!clause.isEmpty()) {
      sql.append(" WHERE ").append(clause.sql);
    }
    Map<String, Object> result = new LinkedHashMap<String, Object>();
    result.put("count", adapter.execute(sql.toString(), clause.params));
    return result;
  }

  /** Updates the matching row when it exists, creates it otherwise. */
  public Map<String, Object> upsert(
      Map<String, Object> where, Map<String, Object> createData, Map<String, Object> updateData)
      throws SQLException {
    Map<String, Object> existing = findFirst(where);
    if (existing != null) {
      Map<String, Object> updated = update(where, updateData);
      return updated == null ? existing : updated;
    }
    return create(createData);
  }

  // ─── Aggregation ────────────────────────────────────────────────────────────────

  private void validateAggregateFields(An5Aggregate spec) {
    boolean hasFields = Metadata.hasFields(modelName);
    for (String field : spec.countFields()) {
      validateModelField(field, "_count", hasFields);
    }
    for (String field : spec.sumFields()) {
      validateModelField(field, "_sum", hasFields);
    }
    for (String field : spec.avgFields()) {
      validateModelField(field, "_avg", hasFields);
    }
    for (String field : spec.minFields()) {
      validateModelField(field, "_min", hasFields);
    }
    for (String field : spec.maxFields()) {
      validateModelField(field, "_max", hasFields);
    }
  }

  private void validateModelField(String field, String context, boolean hasFields) {
    if ("_all".equals(field)) {
      if (!"_count".equals(context)) {
        throw new IllegalArgumentException(
            "'_all' is only valid inside '_count', not '" + context + "'");
      }
      return;
    }
    if (hasFields && !Metadata.hasField(modelName, field)) {
      throw new IllegalArgumentException(
          "unknown field '" + field + "' on model '" + modelName + "' in " + context);
    }
  }

  /** One row of aggregate values, keyed {@code _count}, {@code _sum_<field>} and so on. */
  public Map<String, Object> aggregate(An5Aggregate aggregate) throws SQLException {
    validateAggregateFields(aggregate);
    List<String> expressions = aggregate.selectExpressions(dialect);
    if (expressions.isEmpty()) {
      throw new IllegalArgumentException("aggregate requires at least one aggregator column");
    }
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(aggregate.whereMap(), dialect, params, "", modelName);
    StringBuilder sql =
        new StringBuilder("SELECT ")
            .append(join(expressions, ", "))
            .append(" FROM ")
            .append(tableSql());
    if (!where.isEmpty()) {
      sql.append(" WHERE ").append(where.sql);
    }
    List<Map<String, Object>> rows = adapter.exec(sql.toString(), where.params);
    return rows.isEmpty() ? new LinkedHashMap<String, Object>() : rows.get(0);
  }

  /** One row per group, each carrying the group's {@code _count} and aggregates. */
  public List<Map<String, Object>> groupBy(An5GroupBy group) throws SQLException {
    List<String> byFields = group.byFields();
    if (byFields.isEmpty()) {
      throw new IllegalArgumentException("groupBy requires at least one 'by' column");
    }
    boolean hasFields = Metadata.hasFields(modelName);
    for (String byField : byFields) {
      validateModelField(byField, "by", hasFields);
    }
    validateAggregateFields(group);

    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(group.whereMap(), dialect, params, "", modelName);
    SqlBuilder.Where having =
        SqlBuilder.buildHaving(group.havingMap(), dialect, byFields, params, "h_", modelName);

    String byColumns = quoteAll(byFields);
    // Counted unconditionally: a group is only useful next to its size, and a group whose
    // rows were all filtered out still has to come back as a zero rather than disappear.
    List<String> expressions = new ArrayList<String>();
    expressions.add("COUNT(*) AS _count");
    for (String expression : group.selectExpressions(dialect)) {
      if (!"COUNT(*) AS _count".equals(expression)) {
        expressions.add(expression);
      }
    }

    StringBuilder sql =
        new StringBuilder("SELECT ")
            .append(byColumns)
            .append(", ")
            .append(join(expressions, ", "))
            .append(" FROM ")
            .append(tableSql());
    if (!where.isEmpty()) {
      sql.append(" WHERE ").append(where.sql);
    }
    sql.append(" GROUP BY ").append(byColumns);
    if (!having.isEmpty()) {
      sql.append(" HAVING ").append(having.sql);
    }

    Integer take = group.takeValue();
    int skip = group.skipValue();
    boolean paging = take != null || skip > 0;
    String orderSql = SqlBuilder.buildOrderBy(group.orderByValue(), dialect);
    if (orderSql.isEmpty() && paging) {
      // Paging an unordered result gives an arbitrary slice of the groups; ordering by the
      // group columns at least makes the same query return the same slice.
      orderSql = "ORDER BY " + byColumns;
    }
    if (!orderSql.isEmpty()) {
      sql.append(' ').append(orderSql);
    }
    if (paging) {
      sql.append(dialect.pagination(take, skip, orderSql));
    }
    return adapter.exec(sql.toString(), new ArrayList<Object>(params.values()));
  }

  // ─── Vector search ──────────────────────────────────────────────────────────────

  /**
   * Nearest rows to {@code vector}, by the database's own vector functions where it has
   * them and in memory where it does not.
   *
   * <p>SQLite has no vector operators at all, so it goes straight to the fallback rather
   * than building SQL that will only throw.
   */
  public List<Map<String, Object>> vectorSearch(
      double[] vector, Integer take, Map<String, Object> where, String vectorField, String metric)
      throws SQLException {
    int limit = take == null ? 10 : take;
    String field = vectorField == null || vectorField.isEmpty() ? "embedding" : vectorField;
    String distanceMetric = metric == null || metric.isEmpty() ? "cosine" : metric;

    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "", modelName);

    if (dialect == Dialect.SQLITE) {
      // SQLite ranks through sqlite-vec, a registered distance function or json_each,
      // whichever this connection supports, so the table never has to leave the database.
      List<Map<String, Object>> ranked =
          sqliteVectorSearch(vector, limit, field, distanceMetric, clause);
      if (ranked != null) {
        return ranked;
      }
      // No in-database strategy: score the column in Java instead.
      return scoreVectorsInMemory(vector, limit, field, distanceMetric, where);
    }

    try {
      return nativeVectorSearch(vector, limit, field, distanceMetric, clause);
    } catch (SQLException ignored) {
      // The engine may have no vector extension installed at all. Falling through to the
      // in-memory path is the documented behaviour, not a silent success.
    }
    return scoreVectorsInMemory(vector, limit, field, distanceMetric, where);
  }

  /**
   * SQLite ranks a {@code VECTOR(n)} column inside the database.
   *
   * <p>Returns {@code null} when the connection offers no strategy, so the caller falls back to
   * scoring in Java.
   */
  private List<Map<String, Object>> sqliteVectorSearch(
      double[] vector, int limit, String field, String metric, SqlBuilder.Where where) {
    String column = dialect.quoteIdentifier(field);
    String tail = where.isEmpty() ? "" : " WHERE " + where.sql;
    SqliteVectors.Capabilities capabilities = adapter.sqliteVectorCapabilities();
    String declared = adapter.sqliteColumnType(Metadata.resolveTable(modelName), field);

    for (String strategy :
        SqliteVectors.planStrategies(capabilities, declared, adapter.vectorStrategy())) {
      List<Object> bind = new ArrayList<Object>();
      if (SqliteVectors.STRATEGY_SQL.equals(strategy)) {
        try {
          List<Map<String, Object>> binary = adapter.exec("SELECT 1 FROM " + tableSql()
              + (tail.isEmpty() ? " WHERE " : tail + " AND ")
              + "typeof(" + column + ") = 'blob' LIMIT 1", where.params);
          if (!binary.isEmpty()) continue;
        } catch (SQLException ignored) { continue; }
      }
      String sql =
          SqliteVectors.buildRankingQuery(
              strategy, metric, tableSql(), column, vector, limit, tail,
              dialect.placeholder(), bind);
      if (sql == null) {
        continue;
      }
      // The strategy's own placeholders sit inside the ranked subquery, so their values lead
      // the list; the caller's WHERE values follow, because its placeholders come after them.
      List<Object> values = new ArrayList<Object>(bind);
      values.addAll(where.params);
      try {
        return decodeVectorRows(adapter.exec(sql, values));
      } catch (SQLException ignored) {
        // The connection advertised the capability but the query failed, e.g. an extension
        // that did not really load. The next strategy is cheaper than reporting the failure.
      }
    }
    return null;
  }

  /**
   * Ranks the vector column in Java.
   *
   * <p>The last resort for every provider, and the only option on a SQLite connection that
   * offers no in-database strategy. The whole table is loaded, so it is only reasonable for a
   * table small enough to fit in memory.
   */
  private List<Map<String, Object>> scoreVectorsInMemory(
      double[] vector, int limit, String field, String metric, Map<String, Object> where)
      throws SQLException {
    int dimension = vector.length;
    An5Query query = where == null ? new An5Query() : new An5Query().where(where);
    List<Map<String, Object>> rows = findMany(query);
    List<Integer> scored = new ArrayList<Integer>();
    List<Double> distances = new ArrayList<Double>();
    for (int i = 0; i < rows.size(); i++) {
      double[] stored = SqliteVectors.decodeVector(rows.get(i).get(field), dimension);
      if (stored == null) {
        continue;
      }
      scored.add(i);
      distances.add(Vectors.distance(metric, vector, stored));
    }
    Comparator<Integer> byDistance =
        new Comparator<Integer>() {
          @Override
          public int compare(Integer left, Integer right) {
            return Double.compare(distances.get(left), distances.get(right));
          }
        };
    Collections.sort(scored, byDistance);

    List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
    for (int i = 0; i < scored.size() && i < limit; i++) {
      Map<String, Object> row = new LinkedHashMap<String, Object>(rows.get(scored.get(i)));
      row.put("distance", distances.get(scored.get(i)));
      out.add(row);
    }
    return out;
  }

  private List<Map<String, Object>> nativeVectorSearch(
      double[] vector, int limit, String field, String metric, SqlBuilder.Where where)
      throws SQLException {
    int dimension = vector.length;
    String quotedField = dialect.quoteIdentifier(field);
    String placeholder = dialect.placeholder();
    StringBuilder sql = new StringBuilder();

    if (dialect == Dialect.POSTGRES) {
      String operator;
      if ("euclidean".equalsIgnoreCase(metric)) {
        operator = "<->";
      } else if ("dot".equalsIgnoreCase(metric)) {
        operator = "<#>";
      } else {
        operator = "<=>";
      }
      sql.append("SELECT *, (")
          .append(quotedField)
          .append(' ')
          .append(operator)
          .append(' ')
          .append(placeholder)
          .append("::vector) AS distance FROM ")
          .append(tableSql());
      sql.append(" WHERE ").append(quotedField).append(" IS NOT NULL");
      if (!where.isEmpty()) {
        sql.append(" AND (").append(where.sql).append(')');
      }
      sql.append(" ORDER BY distance ASC LIMIT ").append(limit);
    } else {
      sql.append("SELECT TOP (")
          .append(limit)
          .append(") *, VECTOR_DISTANCE('")
          .append(metric)
          .append("', CAST(")
          .append(quotedField)
          .append(" AS VECTOR(")
          .append(dimension)
          .append(", float32)), CAST(")
          .append(placeholder)
          .append(" AS VECTOR(")
          .append(dimension)
          .append(", float32))) AS distance FROM ")
          .append(tableSql())
          .append(nolock());
      sql.append(" WHERE ").append(quotedField).append(" IS NOT NULL");
      if (!where.isEmpty()) {
        sql.append(" AND (").append(where.sql).append(')');
      }
      sql.append(" ORDER BY distance ASC");
    }

    // The vector leads the value list because its placeholder leads the SQL.
    List<Object> values = new ArrayList<Object>();
    values.add(Vectors.formatVector(vector));
    values.addAll(where.params);
    return adapter.exec(sql.toString(), values);
  }

  // ─── Relations ──────────────────────────────────────────────────────────────────

  private static final class CountTarget {
    final String relKey;
    final RelationDef relation;
    final Object where;

    CountTarget(String relKey, RelationDef relation, Object where) {
      this.relKey = relKey;
      this.relation = relation;
      this.where = where;
    }
  }

  private static String joinKeyToken(Object value) {
    if (value == null) {
      return null;
    }
    if (value instanceof Boolean) {
      return "b:" + value;
    }
    if (value instanceof Number) {
      if (value instanceof Double || value instanceof Float) {
        double d = ((Number) value).doubleValue();
        if (d == Math.rint(d) && d >= Long.MIN_VALUE && d <= Long.MAX_VALUE) {
          return "i:" + ((long) d);
        }
        return "d:" + d;
      }
      return "i:" + ((Number) value).longValue();
    }
    return "s:" + String.valueOf(value);
  }

  private static Integer parseIncludePageBound(Object raw, String field, String relKey) {
    if (raw == null) {
      return null;
    }
    if (!(raw instanceof Number)) {
      throw new IllegalArgumentException(
          "include." + field + " for relation '" + relKey + "' must be a non-negative integer");
    }
    double d = ((Number) raw).doubleValue();
    if (d < 0 || d != Math.rint(d) || d > Integer.MAX_VALUE) {
      throw new IllegalArgumentException(
          "include." + field + " for relation '" + relKey + "' must be a non-negative integer");
    }
    return Integer.valueOf((int) d);
  }

  private static List<CountTarget> parseCountTargets(
      String currentModel, Map<String, RelationDef> relations, Object countSpec) {
    List<CountTarget> targets = new ArrayList<CountTarget>();
    if (countSpec == null) {
      return targets;
    }
    if (countSpec instanceof Boolean) {
      if (!Boolean.TRUE.equals(countSpec)) {
        return targets;
      }
      List<String> keys = new ArrayList<String>();
      for (Map.Entry<String, RelationDef> entry : relations.entrySet()) {
        if (entry.getValue().isMany()) {
          keys.add(entry.getKey());
        }
      }
      Collections.sort(keys);
      for (String k : keys) {
        targets.add(new CountTarget(k, relations.get(k), null));
      }
      return targets;
    }
    if (!(countSpec instanceof Map)) {
      throw new IllegalArgumentException("Invalid _count payload for model '" + currentModel + "'");
    }
    Map<?, ?> rawMap = (Map<?, ?>) countSpec;
    Map<?, ?> selection = rawMap;
    if (rawMap.containsKey("select")) {
      if (rawMap.size() > 1) {
        throw new IllegalArgumentException(
            "Unknown option alongside 'select' in _count for model '" + currentModel + "'");
      }
      Object selObj = rawMap.get("select");
      if (selObj == null) {
        return targets;
      }
      if (!(selObj instanceof Map)) {
        throw new IllegalArgumentException("_count.select for model '" + currentModel + "' must be a map");
      }
      selection = (Map<?, ?>) selObj;
    }

    for (Map.Entry<?, ?> entry : selection.entrySet()) {
      Object val = entry.getValue();
      if (val == null || Boolean.FALSE.equals(val)) {
        continue;
      }
      String relKey = String.valueOf(entry.getKey());
      RelationDef relation = relations.get(relKey);
      if (relation == null || !relation.isMany()) {
        throw new IllegalArgumentException(
            "Unknown or non-list relation '" + relKey + "' in _count for model '" + currentModel + "'");
      }
      Object countWhere = null;
      if (Boolean.TRUE.equals(val)) {
        countWhere = null;
      } else if (val instanceof Map) {
        Map<?, ?> optMap = (Map<?, ?>) val;
        for (Map.Entry<?, ?> opt : optMap.entrySet()) {
          String optKey = String.valueOf(opt.getKey());
          if (!"where".equals(optKey)) {
            throw new IllegalArgumentException(
                "Unsupported option '" + optKey + "' in _count." + relKey);
          }
          countWhere = opt.getValue();
        }
      } else {
        throw new IllegalArgumentException(
            "Unsupported _count option for relation '" + relKey + "' on '" + currentModel + "'");
      }
      targets.add(new CountTarget(relKey, relation, countWhere));
    }
    return targets;
  }

  private static List<String> extractSelectFieldNames(Object selectObj) {
    List<String> fields = new ArrayList<String>();
    if (selectObj instanceof List) {
      for (Object field : (List<?>) selectObj) {
        if (field != null && !String.valueOf(field).isEmpty()) {
          fields.add(String.valueOf(field));
        }
      }
    } else if (selectObj instanceof Map) {
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) selectObj).entrySet()) {
        if (Boolean.TRUE.equals(entry.getValue()) && entry.getKey() != null) {
          fields.add(String.valueOf(entry.getKey()));
        }
      }
    }
    return fields;
  }

  /** Eager-loads relations onto rows already fetched, in place. */
  @SuppressWarnings("unchecked")
  private void resolveIncludes(
      String currentModel,
      Map<String, RelationDef> relations,
      List<Map<String, Object>> rows,
      Map<String, Object> include)
      throws SQLException {
    if (rows == null || rows.isEmpty() || include == null || include.isEmpty()) {
      return;
    }

    for (Map.Entry<String, Object> entry : include.entrySet()) {
      String key = entry.getKey();
      Object value = entry.getValue();
      if (value == null || Boolean.FALSE.equals(value)) {
        continue;
      }

      if ("_count".equals(key)) {
        applyRelationCounts(currentModel, relations, rows, value);
        continue;
      }

      RelationDef relation = relations.get(key);
      if (relation == null) {
        continue;
      }
      boolean isMany = relation.isMany();
      String[] keys = Metadata.relationKeys(currentModel, relation);
      String matchKey = keys[0];
      String joinKey = keys[1];

      Integer skipVal = null;
      Integer takeVal = null;
      Map<String, Object> nestedIncludeMap = null;
      List<String> nestedSelectFields = null;
      Object extraWhere = null;
      Object subOrderBy = null;

      if (value instanceof Map) {
        Map<String, Object> options = (Map<String, Object>) value;
        extraWhere = options.get("where");
        subOrderBy = options.get("orderBy");
        skipVal = parseIncludePageBound(options.get("skip"), "skip", key);
        takeVal = parseIncludePageBound(options.get("take"), "take", key);
        if (options.get("include") instanceof Map) {
          nestedIncludeMap = (Map<String, Object>) options.get("include");
        }
        if (options.get("select") != null) {
          List<String> extracted = extractSelectFieldNames(options.get("select"));
          if (!extracted.isEmpty()) {
            nestedSelectFields = extracted;
          }
        }
      }

      List<Object> uniqueKeys = uniqueKeys(rows, joinKey);
      if (uniqueKeys.isEmpty() || (isMany && takeVal != null && takeVal.intValue() == 0)) {
        for (Map<String, Object> row : rows) {
          row.put(key, isMany ? new ArrayList<Object>() : null);
        }
        continue;
      }

      Map<String, Object> baseWhere = single(matchKey, single("in", uniqueKeys));
      Map<String, Object> nestedWhere = baseWhere;
      if (extraWhere instanceof Map && !((Map<?, ?>) extraWhere).isEmpty()) {
        nestedWhere = single("AND", Arrays.<Object>asList(baseWhere, extraWhere));
      }
      An5Query nested = new An5Query().where(nestedWhere);
      if (subOrderBy != null) {
        nested.orderBy(subOrderBy);
      }

      List<Map<String, Object>> related = adapter.table(relation.modelName).findMany(nested);

      Map<String, List<Integer>> groups = new LinkedHashMap<String, List<Integer>>();
      for (int i = 0; i < related.size(); i++) {
        String token = joinKeyToken(related.get(i).get(matchKey));
        if (token == null) {
          continue;
        }
        if (!groups.containsKey(token)) {
          groups.put(token, new ArrayList<Integer>());
        }
        groups.get(token).add(Integer.valueOf(i));
      }

      Map<String, List<Integer>> slicedByToken = new LinkedHashMap<String, List<Integer>>();
      List<Map<String, Object>> surviving = new ArrayList<Map<String, Object>>();
      List<Integer> survivingIdxs = new ArrayList<Integer>();
      Set<Integer> seenIdx = new LinkedHashSet<Integer>();
      int skipOffset = skipVal != null ? skipVal.intValue() : 0;

      for (Map.Entry<String, List<Integer>> grp : groups.entrySet()) {
        List<Integer> bucket = grp.getValue();
        List<Integer> picked = new ArrayList<Integer>();
        if (isMany) {
          for (int i = skipOffset; i < bucket.size(); i++) {
            if (takeVal != null && picked.size() >= takeVal.intValue()) {
              break;
            }
            picked.add(bucket.get(i));
          }
        } else if (!bucket.isEmpty()) {
          picked.add(bucket.get(0));
        }
        slicedByToken.put(grp.getKey(), picked);
        for (Integer idx : picked) {
          if (seenIdx.add(idx)) {
            survivingIdxs.add(idx);
            surviving.add(related.get(idx.intValue()));
          }
        }
      }

      Map<String, RelationDef> childRelations = Metadata.relationsFor(relation.modelName);
      if (nestedIncludeMap != null && !surviving.isEmpty()) {
        resolveIncludes(relation.modelName, childRelations, surviving, nestedIncludeMap);
      }
      if (nestedSelectFields != null && !surviving.isEmpty() && hasRelationSelect(nestedSelectFields, childRelations)) {
        resolveIncludes(relation.modelName, childRelations, surviving, relationSelect(nestedSelectFields, childRelations));
      }

      Map<Integer, Map<String, Object>> projectedByIdx = new LinkedHashMap<Integer, Map<String, Object>>();
      if (nestedSelectFields != null) {
        List<Map<String, Object>> projectedList =
            projectFields(surviving, nestedSelectFields, collectIncludeKeys(nestedIncludeMap));
        for (int i = 0; i < survivingIdxs.size(); i++) {
          projectedByIdx.put(survivingIdxs.get(i), projectedList.get(i));
        }
      }

      for (Map<String, Object> row : rows) {
        String token = joinKeyToken(row.get(joinKey));
        List<Integer> matchedIdxs = token != null ? slicedByToken.get(token) : null;
        if (isMany) {
          List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
          if (matchedIdxs != null) {
            for (Integer idx : matchedIdxs) {
              out.add(nestedSelectFields != null ? projectedByIdx.get(idx) : related.get(idx.intValue()));
            }
          }
          row.put(key, out);
        } else {
          if (matchedIdxs != null && !matchedIdxs.isEmpty()) {
            Integer idx = matchedIdxs.get(0);
            row.put(key, nestedSelectFields != null ? projectedByIdx.get(idx) : related.get(idx.intValue()));
          } else {
            row.put(key, null);
          }
        }
      }
    }
  }

  @SuppressWarnings("unchecked")
  private void applyRelationCounts(
      String currentModel,
      Map<String, RelationDef> relations,
      List<Map<String, Object>> rows,
      Object countSpec)
      throws SQLException {
    for (Map<String, Object> row : rows) {
      if (!(row.get("_count") instanceof Map)) {
        row.put("_count", new LinkedHashMap<String, Object>());
      }
    }
    List<CountTarget> targets = parseCountTargets(currentModel, relations, countSpec);
    for (CountTarget target : targets) {
      String[] keys = Metadata.relationKeys(currentModel, target.relation);
      String matchKey = keys[0];
      String joinKey = keys[1];
      List<Object> uniqueKeys = uniqueKeys(rows, joinKey);
      if (uniqueKeys.isEmpty()) {
        for (Map<String, Object> row : rows) {
          ((Map<String, Object>) row.get("_count")).put(target.relKey, Integer.valueOf(0));
        }
        continue;
      }
      Map<String, Integer> counts = new LinkedHashMap<String, Integer>();
      Map<String, Object> baseWhere = single(matchKey, single("in", uniqueKeys));
      Map<String, Object> countWhere = baseWhere;
      if (target.where instanceof Map && !((Map<?, ?>) target.where).isEmpty()) {
        countWhere = single("AND", Arrays.<Object>asList(baseWhere, target.where));
      }
      List<Map<String, Object>> related =
          adapter.table(target.relation.modelName).findMany(new An5Query().where(countWhere));
      for (Map<String, Object> row : related) {
        String token = joinKeyToken(row.get(matchKey));
        if (token == null) {
          continue;
        }
        counts.put(token, counts.containsKey(token) ? counts.get(token) + 1 : 1);
      }
      for (Map<String, Object> row : rows) {
        String token = joinKeyToken(row.get(joinKey));
        Integer count = token == null ? null : counts.get(token);
        ((Map<String, Object>) row.get("_count")).put(target.relKey, count == null ? Integer.valueOf(0) : count);
      }
    }
  }

  /** The relation objects in a write payload, keyed by relation name. */
  private Map<String, Object> splitRelationWrites(Map<String, Object> data) {
    Map<String, RelationDef> relations = Metadata.relationsFor(modelName);
    Map<String, Object> relationWrites = new LinkedHashMap<String, Object>();
    for (Map.Entry<String, Object> entry : data.entrySet()) {
      if (relations.containsKey(entry.getKey()) && entry.getValue() instanceof Map) {
        relationWrites.put(entry.getKey(), entry.getValue());
      }
    }
    return relationWrites;
  }

  /**
   * The write payload with the relation objects removed.
   *
   * <p>A relation has no column, so leaving its key in the payload would put it into the
   * {@code INSERT} list and the database would reject the column name.
   */
  private Map<String, Object> withoutRelations(Map<String, Object> data) {
    Map<String, Object> scalars = new LinkedHashMap<String, Object>(data);
    for (String key : splitRelationWrites(data).keySet()) {
      scalars.remove(key);
    }
    return scalars;
  }

  @SuppressWarnings("unchecked")
  private void applyRelationCreates(Map<String, Object> parent, Map<String, Object> relationWrites)
      throws SQLException {
    Map<String, RelationDef> relations = Metadata.relationsFor(modelName);
    for (Map.Entry<String, Object> entry : relationWrites.entrySet()) {
      RelationDef relation = relations.get(entry.getKey());
      if (relation == null || !(entry.getValue() instanceof Map)) {
        continue;
      }
      Object create = ((Map<String, Object>) entry.getValue()).get("create");
      if (create == null) {
        continue;
      }
      for (Object item : toList(create)) {
        if (!(item instanceof Map)) {
          continue;
        }
        Map<String, Object> merged = new LinkedHashMap<String, Object>((Map<String, Object>) item);
        merged.put(relation.foreignKey, parent == null ? null : parent.get(relation.localKey));
        adapter.table(relation.modelName).create(merged);
      }
    }
  }

  @SuppressWarnings("unchecked")
  private void applyRelationUpdates(
      Map<String, Object> parent, Map<String, Object> where, Map<String, Object> relationWrites)
      throws SQLException {
    Map<String, RelationDef> relations = Metadata.relationsFor(modelName);
    for (Map.Entry<String, Object> entry : relationWrites.entrySet()) {
      RelationDef relation = relations.get(entry.getKey());
      if (relation == null || !(entry.getValue() instanceof Map)) {
        continue;
      }
      Map<String, Object> write = (Map<String, Object>) entry.getValue();
      An5TableClient child = adapter.table(relation.modelName);

      Object create = write.get("create");
      if (create != null) {
        for (Object item : toList(create)) {
          if (!(item instanceof Map)) {
            continue;
          }
          Map<String, Object> merged = new LinkedHashMap<String, Object>((Map<String, Object>) item);
          merged.put(relation.foreignKey, parent == null ? null : parent.get(relation.localKey));
          child.create(merged);
        }
      }

      Object update = write.get("update");
      if (update instanceof Map) {
        Map<String, Object> spec = (Map<String, Object>) update;
        Object nestedWhere = spec.get("where");
        Object nestedData = spec.get("data");
        // Falls back to the parent's filter, never to "no filter": a relation update with no
        // filter of its own would otherwise rewrite every row of the related table.
        child.update(
            nestedWhere instanceof Map ? (Map<String, Object>) nestedWhere : where,
            nestedData instanceof Map
                ? (Map<String, Object>) nestedData
                : new LinkedHashMap<String, Object>());
      }

      Object disconnect = write.get("disconnect");
      if (disconnect instanceof Map) {
        child.updateMany((Map<String, Object>) disconnect, single(relation.foreignKey, null));
      }
    }
  }

  private Map<String, Object> projectAfterWrite(Map<String, Object> row, An5Query query)
      throws SQLException {
    if (row == null) {
      return null;
    }
    List<Map<String, Object>> rows = new ArrayList<Map<String, Object>>();
    rows.add(row);
    Map<String, RelationDef> relations = Metadata.relationsFor(modelName);
    if (!collectIncludeKeys(query.includeValue()).isEmpty()) {
      resolveIncludes(modelName, relations, rows, query.includeValue());
    }
    if (query.selectValue() != null) {
      resolveIncludes(modelName, relations, rows, relationSelect(query.selectValue(), relations));
      return projectFields(rows, query.selectValue(), collectIncludeKeys(query.includeValue())).get(0);
    }
    return row;
  }

  // ─── Row helpers ────────────────────────────────────────────────────────────────

  /**
   * The same query with a row cap, leaving the caller's query untouched.
   *
   * <p>Mutating it instead would silently cap every later use of the same object, so a
   * {@code findFirst} would quietly limit a caller's subsequent {@code findMany}.
   */
  private static An5Query limitedTo(An5Query query, int take) {
    return new An5Query()
        .where(query.whereMap())
        .orderBy(query.orderByValue())
        .skip(query.skipValue())
        .take(take)
        .select(query.selectValue() == null ? new String[0] : query.selectValue().toArray(new String[0]))
        .include(query.includeValue());
  }

  private static List<String> collectIncludeKeys(Map<String, Object> include) {
    List<String> keys = new ArrayList<String>();
    if (include == null || include.isEmpty()) {
      return keys;
    }
    for (Map.Entry<String, Object> entry : include.entrySet()) {
      Object val = entry.getValue();
      if (val != null && !Boolean.FALSE.equals(val)) {
        keys.add(entry.getKey());
      }
    }
    return keys;
  }

  private static List<Object> uniqueKeys(List<Map<String, Object>> rows, String column) {
    Set<String> seenTokens = new LinkedHashSet<String>();
    List<Object> unique = new ArrayList<Object>();
    for (Map<String, Object> row : rows) {
      Object value = row.get(column);
      String token = joinKeyToken(value);
      if (token != null && seenTokens.add(token)) {
        unique.add(value);
      }
    }
    return unique;
  }

  /** The columns, quoted for this dialect and joined into a comma-separated list. */
  private String quoteAll(List<String> columns) {
    List<String> quoted = new ArrayList<String>();
    for (String column : columns) {
      quoted.add(dialect.quoteIdentifier(column));
    }
    return join(quoted, ", ");
  }

  private static boolean hasRelationSelect(
      List<String> selected, Map<String, RelationDef> relations) {
    for (String field : selected) {
      if ("_count".equals(field) || relations.containsKey(field)) {
        return true;
      }
    }
    return false;
  }

  /** The relation entries of a {@code select} list, as the shape {@code resolveIncludes} takes. */
  private static Map<String, Object> relationSelect(
      List<String> selected, Map<String, RelationDef> relations) {
    Map<String, Object> include = new LinkedHashMap<String, Object>();
    for (String field : selected) {
      if ("_count".equals(field) || relations.containsKey(field)) {
        include.put(field, Boolean.TRUE);
      }
    }
    return include;
  }

  private static List<Map<String, Object>> projectFields(
      List<Map<String, Object>> rows, List<String> selected) {
    return projectFields(rows, selected, Collections.<String>emptyList());
  }

  private static List<Map<String, Object>> projectFields(
      List<Map<String, Object>> rows, List<String> selected, Collection<String> extraKeys) {
    if (selected == null || selected.isEmpty()) {
      return rows;
    }
    List<Map<String, Object>> projected = new ArrayList<Map<String, Object>>();
    for (Map<String, Object> row : rows) {
      Map<String, Object> kept = new LinkedHashMap<String, Object>();
      for (String field : selected) {
        if (row.containsKey(field)) {
          kept.put(field, row.get(field));
        }
      }
      if (extraKeys != null) {
        for (String extra : extraKeys) {
          if (extra != null && row.containsKey(extra) && !kept.containsKey(extra)) {
            kept.put(extra, row.get(extra));
          }
        }
      }
      if (row.containsKey("_count") && !kept.containsKey("_count")) {
        kept.put("_count", row.get("_count"));
      }
      projected.add(kept);
    }
    return projected;
  }

  private static List<Object> toList(Object value) {
    if (value == null) {
      return new ArrayList<Object>();
    }
    if (value instanceof List) {
      return new ArrayList<Object>((List<?>) value);
    }
    List<Object> list = new ArrayList<Object>();
    list.add(value);
    return list;
  }

  private static Map<String, Object> single(String key, Object value) {
    Map<String, Object> map = new LinkedHashMap<String, Object>();
    map.put(key, value);
    return map;
  }

  /** An empty, mutable row map, for callers building one field at a time. */
  public static Map<String, Object> row() {
    return new LinkedHashMap<String, Object>();
  }

  private String join(List<String> parts, String separator) {
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
