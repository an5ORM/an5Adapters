package an5.adapters.base;

/** One column of a model, as emitted by the generator into the metadata module. */
public final class FieldMeta {
  public final String name;
  public final String type;
  public final String sqlType;
  public final boolean optional;
  public final boolean hasDefault;
  public final boolean id;
  public final String description;

  public FieldMeta(
      String name,
      String type,
      String sqlType,
      boolean optional,
      boolean hasDefault,
      boolean id,
      String description) {
    this.name = name;
    this.type = type;
    this.sqlType = sqlType;
    this.optional = optional;
    this.hasDefault = hasDefault;
    this.id = id;
    this.description = description;
  }

  /** The primary key column of a model, or {@code null} when the schema marks none. */
  public static FieldMeta idField(java.util.List<FieldMeta> fields) {
    if (fields == null) {
      return null;
    }
    for (FieldMeta field : fields) {
      if (field.id) {
        return field;
      }
    }
    return null;
  }
}