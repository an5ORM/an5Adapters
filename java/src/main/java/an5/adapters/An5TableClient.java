package an5.adapters;

import an5.adapters.base.Dialect;
import an5.adapters.base.FieldMeta;
import an5.adapters.base.Metadata;
import an5.adapters.base.RelationDef;
import an5.adapters.base.SqlBuilder;
import an5.adapters.base.Vectors;
import java.sql.SQLException;
import java.util.ArrayList;
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

  // ─── Reads ──────────────────────────────────────────────────────────────────────

  public List<Map<String, Object>> findMany() throws SQLException {
    return findMany(new An5Query());
  }

  public List<Map<String, Object>> findMany(An5Query query) throws SQLException {
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(query.whereMap(), dialect, params, "");
    String orderSql = SqlBuilder.buildOrderBy(query.orderByValue(), dialect);

    Map<String, RelationDef> relations = Metadata.relationsFor(modelName);
    List<String> selected = query.selectValue();
    String columns = "SELECT *";
    if (selected != null && !selected.isEmpty() && !hasRelationSelect(selected, relations)) {
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
    if (query.includeValue() != null && !query.includeValue().isEmpty()) {
      resolveIncludes(relations, rows, query.includeValue());
    }
    if (selected != null) {
      if (hasRelationSelect(selected, relations)) {
        resolveIncludes(relations, rows, relationSelect(selected, relations));
      }
      rows = projectFields(rows, selected);
    }
    return rows;
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
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "");
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
    SqlBuilder.Where where = SqlBuilder.parseWhere(query.whereMap(), dialect, params, "w_");

    Map<String, Object> relationWrites = splitRelationWrites(data);
    Map<String, Object> scalars = withoutRelations(data);

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
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "w_");

    List<String> setParts = new ArrayList<String>();
    List<Object> setValues = new ArrayList<Object>();
    for (Map.Entry<String, Object> entry : data.entrySet()) {
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
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "");
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

  /** One row of aggregate values, keyed {@code _count}, {@code _sum_<field>} and so on. */
  public Map<String, Object> aggregate(An5Aggregate aggregate) throws SQLException {
    List<String> expressions = aggregate.selectExpressions(dialect);
    if (expressions.isEmpty()) {
      throw new IllegalArgumentException("aggregate requires at least one aggregator column");
    }
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(aggregate.whereMap(), dialect, params, "");
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
    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where where = SqlBuilder.parseWhere(group.whereMap(), dialect, params, "");

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
      sql.append(dialect.pagination(take == null ? 1 : take, skip, orderSql));
    }
    return adapter.exec(sql.toString(), where.params);
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
    int dimension = vector.length;

    Map<String, Object> params = new LinkedHashMap<String, Object>();
    SqlBuilder.Where clause = SqlBuilder.parseWhere(where, dialect, params, "");

    if (dialect != Dialect.SQLITE) {
      try {
        return nativeVectorSearch(vector, limit, field, distanceMetric, clause);
      } catch (SQLException ignored) {
        // The engine may have no vector extension installed at all. Falling through to the
        // in-memory path is the documented behaviour, not a silent success.
      }
    }

    An5Query query = where == null ? new An5Query() : new An5Query().where(where);
    List<Map<String, Object>> rows = findMany(query);
    List<Integer> scored = new ArrayList<Integer>();
    List<Double> distances = new ArrayList<Double>();
    for (int i = 0; i < rows.size(); i++) {
      double[] stored = Vectors.parseVector(rows.get(i).get(field), dimension);
      if (stored == null) {
        continue;
      }
      scored.add(i);
      distances.add(Vectors.distance(distanceMetric, vector, stored));
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

  /** Eager-loads relations onto rows already fetched, in place. */
  @SuppressWarnings("unchecked")
  private void resolveIncludes(
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
        applyRelationCounts(relations, rows);
        continue;
      }

      RelationDef relation = relations.get(key);
      if (relation == null) {
        continue;
      }
      boolean isMany = relation.isMany();
      String joinKey = isMany ? relation.localKey : relation.foreignKey;
      String matchKey = isMany ? relation.foreignKey : relation.localKey;

      List<Object> uniqueKeys = uniqueKeys(rows, joinKey);
      if (uniqueKeys.isEmpty()) {
        for (Map<String, Object> row : rows) {
          row.put(key, isMany ? new ArrayList<Object>() : null);
        }
        continue;
      }

      Map<String, Object> nestedWhere = single(matchKey, single("in", uniqueKeys));
      An5Query nested = new An5Query().where(nestedWhere);
      if (value instanceof Map) {
        Map<String, Object> options = (Map<String, Object>) value;
        Object extra = options.get("where");
        if (extra instanceof Map) {
          for (Map.Entry<String, Object> condition : ((Map<String, Object>) extra).entrySet()) {
            nestedWhere.put(condition.getKey(), condition.getValue());
          }
        }
        if (options.get("orderBy") != null) {
          nested.orderBy(options.get("orderBy"));
        }
        if (options.get("skip") instanceof Number) {
          nested.skip(((Number) options.get("skip")).intValue());
        }
        if (options.get("take") instanceof Number) {
          nested.take(((Number) options.get("take")).intValue());
        }
      }

      List<Map<String, Object>> related = adapter.table(relation.modelName).findMany(nested);
      List<Map<String, Object>> projected = related;
      if (value instanceof Map) {
        Map<String, Object> options = (Map<String, Object>) value;
        if (options.get("include") instanceof Map) {
          resolveIncludes(Metadata.relationsFor(relation.modelName), related, (Map<String, Object>) options.get("include"));
        }
        if (options.get("select") instanceof List) {
          List<String> fields = new ArrayList<String>();
          for (Object field : (List<?>) options.get("select")) {
            if (field != null && !String.valueOf(field).isEmpty()) {
              fields.add(String.valueOf(field));
            }
          }
          projected = projectFields(related, fields);
        }
      }

      Map<Object, List<Map<String, Object>>> groups = new LinkedHashMap<Object, List<Map<String, Object>>>();
      String groupColumn = isMany ? relation.foreignKey : relation.localKey;
      for (int i = 0; i < related.size(); i++) {
        Object groupKey = related.get(i).get(groupColumn);
        if (!groups.containsKey(groupKey)) {
          groups.put(groupKey, new ArrayList<Map<String, Object>>());
        }
        groups.get(groupKey).add(projected.get(i));
      }
      String rowColumn = isMany ? relation.localKey : relation.foreignKey;
      for (Map<String, Object> row : rows) {
        List<Map<String, Object>> matches = groups.get(row.get(rowColumn));
        if (isMany) {
          row.put(key, matches == null ? new ArrayList<Object>() : matches);
        } else {
          row.put(key, matches == null || matches.isEmpty() ? null : matches.get(0));
        }
      }
    }
  }

  @SuppressWarnings("unchecked")
  private void applyRelationCounts(
      Map<String, RelationDef> relations, List<Map<String, Object>> rows) throws SQLException {
    for (Map<String, Object> row : rows) {
      row.put("_count", new LinkedHashMap<String, Object>());
    }
    for (Map.Entry<String, RelationDef> entry : relations.entrySet()) {
      RelationDef relation = entry.getValue();
      if (!relation.isMany()) {
        continue;
      }
      List<Object> uniqueKeys = uniqueKeys(rows, relation.localKey);
      if (uniqueKeys.isEmpty()) {
        for (Map<String, Object> row : rows) {
          ((Map<String, Object>) row.get("_count")).put(entry.getKey(), 0);
        }
        continue;
      }
      Map<String, Integer> counts = new LinkedHashMap<String, Integer>();
      List<Map<String, Object>> related =
          adapter
              .table(relation.modelName)
              .findMany(new An5Query().where(single(relation.foreignKey, single("in", uniqueKeys))));
      for (Map<String, Object> row : related) {
        Object key = row.get(relation.foreignKey);
        if (key == null) {
          continue;
        }
        String asString = String.valueOf(key);
        counts.put(asString, counts.containsKey(asString) ? counts.get(asString) + 1 : 1);
      }
      for (Map<String, Object> row : rows) {
        Object key = row.get(relation.localKey);
        Integer count = key == null ? null : counts.get(String.valueOf(key));
        ((Map<String, Object>) row.get("_count")).put(entry.getKey(), count == null ? 0 : count);
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
    if (query.includeValue() != null && !query.includeValue().isEmpty()) {
      resolveIncludes(relations, rows, query.includeValue());
    }
    if (query.selectValue() != null) {
      resolveIncludes(relations, rows, relationSelect(query.selectValue(), relations));
      return projectFields(rows, query.selectValue()).get(0);
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

  private static List<Object> uniqueKeys(List<Map<String, Object>> rows, String column) {
    Set<Object> seen = new LinkedHashSet<Object>();
    for (Map<String, Object> row : rows) {
      Object value = row.get(column);
      // Numbers are normalised so that a key read as an int in one row and a long in the
      // next does not turn into two `IN` values for the same row.
      if (value != null) {
        seen.add(value instanceof Number ? ((Number) value).doubleValue() : value);
      }
    }
    return new ArrayList<Object>(seen);
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
      if (row.containsKey("_count")) {
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