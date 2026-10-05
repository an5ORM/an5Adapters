package an5.adapters;

import java.sql.SQLException;
import java.util.List;
import java.util.Map;

/**
 * A read-only client for a database view.
 *
 * <p>Reads go straight to the underlying table client, which already knows how to select
 * from an arbitrary name. Every mutation is refused rather than attempted: a view has no
 * rows to write, and the databases disagree about whether the statement is even legal, so
 * the error is raised here where it can name the reason.
 */
public class An5ViewClient {

  private final An5TableClient client;
  private final String viewName;

  public An5ViewClient(An5Adapter adapter, String viewName) {
    this.client = adapter.table(viewName);
    this.viewName = viewName;
  }

  public String viewName() {
    return viewName;
  }

  public List<Map<String, Object>> findMany() throws SQLException {
    return client.findMany();
  }

  public List<Map<String, Object>> findMany(An5Query query) throws SQLException {
    return client.findMany(query);
  }

  public Map<String, Object> findFirst(An5Query query) throws SQLException {
    return client.findFirst(query);
  }

  public Map<String, Object> findFirst(Map<String, Object> where) throws SQLException {
    return client.findFirst(where);
  }

  public Map<String, Object> findUnique(An5Query query) throws SQLException {
    return client.findUnique(query);
  }

  public Map<String, Object> findUnique(Map<String, Object> where) throws SQLException {
    return client.findUnique(where);
  }

  public long count() throws SQLException {
    return client.count();
  }

  public long count(Map<String, Object> where) throws SQLException {
    return client.count(where);
  }

  public Map<String, Object> aggregate(An5Aggregate aggregate) throws SQLException {
    return client.aggregate(aggregate);
  }

  public List<Map<String, Object>> groupBy(An5GroupBy group) throws SQLException {
    return client.groupBy(group);
  }

  public List<Map<String, Object>> vectorSearch(
      double[] vector, Integer take, Map<String, Object> where, String vectorField, String metric)
      throws SQLException {
    return client.vectorSearch(vector, take, where, vectorField, metric);
  }

  public Map<String, Object> create(Map<String, Object> data) throws SQLException {
    throw readOnly("create");
  }

  public Map<String, Object> update(Map<String, Object> where, Map<String, Object> data)
      throws SQLException {
    throw readOnly("update");
  }

  public Map<String, Object> updateMany(Map<String, Object> where, Map<String, Object> data)
      throws SQLException {
    throw readOnly("updateMany");
  }

  public Map<String, Object> delete(Map<String, Object> where) throws SQLException {
    throw readOnly("delete");
  }

  public Map<String, Object> deleteMany(Map<String, Object> where) throws SQLException {
    throw readOnly("deleteMany");
  }

  public Map<String, Object> upsert(
      Map<String, Object> where, Map<String, Object> createData, Map<String, Object> updateData)
      throws SQLException {
    throw readOnly("upsert");
  }

  private UnsupportedOperationException readOnly(String operation) {
    return new UnsupportedOperationException(
        "View '" + viewName + "' is read-only; " + operation + " is not allowed on it.");
  }
}