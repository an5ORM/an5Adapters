package an5.adapters;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * A grouped aggregate: the {@code GROUP BY} columns plus the aggregates over each group.
 *
 * <p>Extends {@link An5Aggregate} so the same {@code sum}/{@code avg} calls describe both a
 * flat aggregate and a grouped one.
 */
public class An5GroupBy extends An5Aggregate {

  private List<String> by = new ArrayList<String>();
  private Object orderBy;
  private int skip;
  private Integer take;

  /** The columns to group on. At least one is required. */
  public An5GroupBy by(String... columns) {
    this.by.addAll(Arrays.asList(columns));
    return this;
  }

  @Override
  public An5GroupBy count() {
    super.count();
    return this;
  }

  @Override
  public An5GroupBy sum(String... columns) {
    super.sum(columns);
    return this;
  }

  @Override
  public An5GroupBy avg(String... columns) {
    super.avg(columns);
    return this;
  }

  @Override
  public An5GroupBy min(String... columns) {
    super.min(columns);
    return this;
  }

  @Override
  public An5GroupBy max(String... columns) {
    super.max(columns);
    return this;
  }

  @Override
  public An5GroupBy where(java.util.Map<String, Object> where) {
    super.where(where);
    return this;
  }

  public An5GroupBy orderBy(String column, String direction) {
    this.orderBy = An5Aggregate.orderEntry(column, direction);
    return this;
  }

  public An5GroupBy orderBy(Object orderBy) {
    this.orderBy = orderBy;
    return this;
  }

  public An5GroupBy skip(int skip) {
    this.skip = Math.max(0, skip);
    return this;
  }

  public An5GroupBy take(Integer take) {
    this.take = take;
    return this;
  }

  public List<String> byFields() {
    return by;
  }

  public Object orderByValue() {
    return orderBy;
  }

  public int skipValue() {
    return skip;
  }

  public Integer takeValue() {
    return take;
  }
}