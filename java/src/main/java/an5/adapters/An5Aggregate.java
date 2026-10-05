package an5.adapters;

import an5.adapters.base.Dialect;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Which aggregates a query computes.
 *
 * <p>Each list names columns to apply the aggregate to; the first list added wins for a
 * given metric, so calling {@link #sum} twice widens the first call rather than replacing it.
 */
public class An5Aggregate {

  private boolean count;
  private List<String> sum = new ArrayList<String>();
  private List<String> avg = new ArrayList<String>();
  private List<String> min = new ArrayList<String>();
  private List<String> max = new ArrayList<String>();
  private Map<String, Object> where;

  /** Adds {@code COUNT(*)}. */
  public An5Aggregate count() {
    this.count = true;
    return this;
  }

  public An5Aggregate sum(String... columns) {
    this.sum.addAll(Arrays.asList(columns));
    return this;
  }

  public An5Aggregate avg(String... columns) {
    this.avg.addAll(Arrays.asList(columns));
    return this;
  }

  public An5Aggregate min(String... columns) {
    this.min.addAll(Arrays.asList(columns));
    return this;
  }

  public An5Aggregate max(String... columns) {
    this.max.addAll(Arrays.asList(columns));
    return this;
  }

  /** Restricts the rows the aggregate runs over. */
  public An5Aggregate where(Map<String, Object> where) {
    this.where = where;
    return this;
  }

  public boolean countEnabled() {
    return count;
  }

  public List<String> sumFields() {
    return sum;
  }

  public List<String> avgFields() {
    return avg;
  }

  public List<String> minFields() {
    return min;
  }

  public List<String> maxFields() {
    return max;
  }

  public Map<String, Object> whereMap() {
    return where;
  }

  /**
   * The {@code SELECT} list for this aggregate, in a stable order.
   *
   * <p>Order is fixed so the same aggregate always produces the same SQL, which is what
   * makes the generated query comparable between runs and cacheable.
   */
  public List<String> selectExpressions(Dialect dialect) {
    List<String> expressions = new ArrayList<String>();
    if (count) {
      expressions.add("COUNT(*) AS _count");
    }
    addFor(expressions, "SUM", sumFields(), dialect);
    addFor(expressions, "AVG", avgFields(), dialect);
    addFor(expressions, "MIN", minFields(), dialect);
    addFor(expressions, "MAX", maxFields(), dialect);
    return expressions;
  }

  private static void addFor(
      List<String> expressions, String function, List<String> fields, Dialect dialect) {
    for (String field : fields) {
      expressions.add(function + "(" + dialect.quoteIdentifier(field) + ") AS _" + lower(function) + "_" + field);
    }
  }

  private static String lower(String value) {
    return value.toLowerCase(java.util.Locale.ROOT);
  }

  /** Convenience for the one-map-per-column form used by several adapters' {@code orderBy}. */
  public static Map<String, Object> orderEntry(String column, String direction) {
    Map<String, Object> entry = new LinkedHashMap<String, Object>();
    entry.put(column, direction);
    return entry;
  }
}