package an5.adapters.base;

/**
 * One relation of a model, as emitted by the generator into the metadata module.
 *
 * <p>{@code relationType} is {@code "one"} or {@code "many"}. The two sides of the join
 * are named the way the foreign key is stored: {@code foreignKey} is the column on the
 * related model that points back, {@code localKey} the column on this model it points to.
 */
public final class RelationDef {
  public final String modelName;
  public final String relationType;
  public final String foreignKey;
  public final String localKey;

  public RelationDef(String modelName, String relationType, String foreignKey, String localKey) {
    this.modelName = modelName;
    this.relationType = relationType == null || relationType.isEmpty() ? "many" : relationType;
    this.foreignKey = foreignKey;
    this.localKey = localKey;
  }

  public boolean isMany() {
    return "many".equals(relationType);
  }
}