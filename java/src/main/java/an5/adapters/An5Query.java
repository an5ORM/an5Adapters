package an5.adapters;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A query built fluently and handed to a table client.
 *
 * <p>Every field is optional, so {@code new An5Query()} means "no filter, no order, no
 * limit" — the same thing the other adapters read from an omitted argument.
 */
public class An5Query {

  private Map<String, Object> where;
  private Object orderBy;
  private int skip;
  private Integer take;
  private List<String> select;
  private Map<String, Object> include;

  public An5Query where(Map<String, Object> where) {
    this.where = where;
    return this;
  }

  /**
   * Orders by a single column, ascending.
   *
   * <p>For several columns, or a descending one, pass the map form:
   * {@code orderBy(Map.of("name", "asc", "createdAt", "desc"))}.
   */
  public An5Query orderBy(String column) {
    Map<String, Object> entry = new LinkedHashMap<String, Object>();
    entry.put(column, "asc");
    this.orderBy = entry;
    return this;
  }

  public An5Query orderBy(String column, String direction) {
    Map<String, Object> entry = new LinkedHashMap<String, Object>();
    entry.put(column, direction);
    this.orderBy = entry;
    return this;
  }

  /** Accepts one entry per column; a {@code List} of them is treated as a multi-column sort. */
  public An5Query orderBy(Object orderBy) {
    this.orderBy = orderBy;
    return this;
  }

  public An5Query skip(int skip) {
    this.skip = Math.max(0, skip);
    return this;
  }

  /** Caps the number of rows. {@code null} — the default — means no limit. */
  public An5Query take(Integer take) {
    this.take = take;
    return this;
  }

  /** Restricts the returned columns; relations and {@code _count} are eager-loaded instead. */
  public An5Query select(String... columns) {
    this.select = columns == null || columns.length == 0 ? null : java.util.Arrays.asList(columns);
    return this;
  }

  /** Eager-loads relations, mirroring the other adapters' {@code include} argument. */
  public An5Query include(Map<String, Object> include) {
    this.include = include;
    return this;
  }

  public Map<String, Object> whereMap() {
    return where;
  }

  public Object orderByValue() {
    return orderBy;
  }

  public int skipValue() {
    return skip;
  }

  /** The row cap, or {@code null} for no limit. */
  public Integer takeValue() {
    return take;
  }

  public List<String> selectValue() {
    return select;
  }

  public Map<String, Object> includeValue() {
    return include;
  }
}