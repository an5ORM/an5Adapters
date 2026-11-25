package an5.adapters.base;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The generated model's table names, columns and relations, registered at start-up.
 *
 * <p>The generated client calls {@link #setAdapterMetadata(Map)} once before it hands out a
 * table client. Nothing here reads the schema, so the adapter stays independent of the
 * generator.
 */
public final class Metadata {

  private static final Map<String, String> MODEL_TO_TABLE = new LinkedHashMap<String, String>();
  private static final Map<String, List<FieldMeta>> MODEL_FIELDS =
      new LinkedHashMap<String, List<FieldMeta>>();
  private static final Map<String, Map<String, RelationDef>> RELATION_MAP =
      new LinkedHashMap<String, Map<String, RelationDef>>();

  private Metadata() {}

  /**
   * Replaces the registry with the metadata the generated client passed in.
   *
   * <p>Called once per client, so it clears first: a second client for another schema in
   * the same JVM must not see the first one's tables.
   */
  public static synchronized void setAdapterMetadata(Map<String, ?> metadata) {
    MODEL_TO_TABLE.clear();
    MODEL_FIELDS.clear();
    RELATION_MAP.clear();
    if (metadata == null) {
      return;
    }

    putStringMap(MODEL_TO_TABLE, first(metadata, "model_to_table", "modelToTable"));

    Map<String, ?> rawFields = first(metadata, "model_fields", "modelFields");
    if (rawFields != null) {
      for (Map.Entry<String, ?> entry : rawFields.entrySet()) {
        MODEL_FIELDS.put(entry.getKey(), readFields(entry.getValue()));
      }
    }

    Map<String, ?> rawRelations = first(metadata, "relation_map", "relationMap", "RELATION_MAP");
    if (rawRelations != null) {
      for (Map.Entry<String, ?> entry : rawRelations.entrySet()) {
        Object value = entry.getValue();
        if (!(value instanceof Map)) {
          continue;
        }
        Map<String, RelationDef> forModel = new LinkedHashMap<String, RelationDef>();
        for (Map.Entry<?, ?> rel : ((Map<?, ?>) value).entrySet()) {
          if (!(rel.getValue() instanceof Map)) {
            continue;
          }
          Map<?, ?> defn = (Map<?, ?>) rel.getValue();
          forModel.put(
              String.valueOf(rel.getKey()),
              new RelationDef(
                  string(defn, "modelName", "model_name", "model"),
                  string(defn, "relationType", "relation_type", "type"),
                  string(defn, "foreignKey", "foreign_key"),
                  string(defn, "localKey", "local_key")));
        }
        RELATION_MAP.put(entry.getKey(), forModel);
      }
    }
  }

  /**
   * The model's name as the metadata keys it, accepting a different capitalisation.
   *
   * <p>The generated client registers tables under their PascalCase name while the metadata
   * keys them in camelCase. A plain lookup would find no columns at all and silently skip
   * {@code isId} — never generating the primary key.
   */
  public static String resolveModelKey(String modelName) {
    if (modelName == null || modelName.isEmpty()) {
      return modelName;
    }
    if (hasKey(modelName)) {
      return modelName;
    }
    String camel = Character.toLowerCase(modelName.charAt(0)) + modelName.substring(1);
    if (hasKey(camel)) {
      return camel;
    }
    String lower = modelName.toLowerCase(Locale.ROOT);
    if (hasKey(lower)) {
      return lower;
    }
    for (String key : MODEL_TO_TABLE.keySet()) {
      if (key.toLowerCase(Locale.ROOT).equals(lower)) {
        return key;
      }
    }
    for (String key : MODEL_FIELDS.keySet()) {
      if (key.toLowerCase(Locale.ROOT).equals(lower)) {
        return key;
      }
    }
    for (String key : RELATION_MAP.keySet()) {
      if (key.toLowerCase(Locale.ROOT).equals(lower)) {
        return key;
      }
    }
    return modelName;
  }

  private static boolean hasKey(String key) {
    return MODEL_TO_TABLE.containsKey(key)
        || MODEL_FIELDS.containsKey(key)
        || RELATION_MAP.containsKey(key);
  }

  /** The table name a model maps to, or the model name when the schema used none. */
  public static String resolveTable(String modelName) {
    String key = resolveModelKey(modelName);
    String table = MODEL_TO_TABLE.get(key);
    return table == null ? modelName : table;
  }

  public static List<FieldMeta> fieldsFor(String modelName) {
    List<FieldMeta> fields = MODEL_FIELDS.get(resolveModelKey(modelName));
    if (fields == null) {
      fields = MODEL_FIELDS.get(modelName);
    }
    return fields == null ? Collections.<FieldMeta>emptyList() : fields;
  }

  /** True when the metadata declares at least one column for {@code modelName}. */
  public static boolean hasFields(String modelName) {
    return !fieldsFor(modelName).isEmpty();
  }

  /** True when {@code modelName} declares a column named {@code fieldName}. */
  public static boolean hasField(String modelName, String fieldName) {
    if (fieldName == null) {
      return false;
    }
    for (FieldMeta field : fieldsFor(modelName)) {
      if (fieldName.equals(field.name)) {
        return true;
      }
    }
    return false;
  }

  public static Map<String, RelationDef> relationsFor(String modelName) {
    Map<String, RelationDef> relations = RELATION_MAP.get(modelName);
    if (relations == null) {
      relations = RELATION_MAP.get(resolveModelKey(modelName));
    }
    return relations == null ? Collections.<String, RelationDef>emptyMap() : relations;
  }

  /** Looks up a single named relation declared on {@code modelName}. */
  public static RelationDef relationFor(String modelName, String relationName) {
    if (modelName == null || modelName.isEmpty() || relationName == null) {
      return null;
    }
    return relationsFor(modelName).get(relationName);
  }

  /**
   * Resolves {@code [childKey, parentKey]} join column names for {@code relation} on {@code
   * modelName}.
   *
   * <p>To-many relations keep {@code foreignKey} on the related child model and {@code localKey} on
   * {@code modelName}. To-one relations generated from {@code @relation(fields: [fk], references:
   * [lk])} record {@code foreignKey} on {@code modelName} and {@code localKey} on the related
   * model, whereas an inverse one-to-one holds {@code foreignKey} on the related model instead.
   */
  public static String[] relationKeys(String modelName, RelationDef relation) {
    String fk = relation.foreignKey == null || relation.foreignKey.isEmpty() ? "id" : relation.foreignKey;
    String lk = relation.localKey == null || relation.localKey.isEmpty() ? "id" : relation.localKey;
    if (relation.isMany()) {
      return new String[] {fk, lk};
    }
    boolean parentHasFk = hasField(modelName, fk);
    boolean childHasFk = hasField(relation.modelName, fk);
    if (parentHasFk && !childHasFk) {
      return new String[] {lk, fk};
    }
    if (childHasFk && !parentHasFk) {
      return new String[] {fk, lk};
    }
    return new String[] {lk, fk};
  }

  /** A snapshot of the registered table map, for callers that want to inspect it. */
  public static Map<String, String> modelToTable() {
    synchronized (Metadata.class) {
      return Collections.unmodifiableMap(new LinkedHashMap<String, String>(MODEL_TO_TABLE));
    }
  }

  private static List<FieldMeta> readFields(Object value) {
    List<FieldMeta> fields = new ArrayList<FieldMeta>();
    if (!(value instanceof List)) {
      return fields;
    }
    for (Object entry : (List<?>) value) {
      if (!(entry instanceof Map)) {
        continue;
      }
      Map<?, ?> field = (Map<?, ?>) entry;
      fields.add(
          new FieldMeta(
              string(field, "name"),
              string(field, "type"),
              string(field, "sql", "sqlType"),
              bool(field, "isOptional", "optional"),
              bool(field, "hasDefault", "default"),
              bool(field, "isId", "id"),
              string(field, "description")));
    }
    return fields;
  }

  private static void putStringMap(Map<String, String> target, Object value) {
    if (!(value instanceof Map)) {
      return;
    }
    for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
      target.put(String.valueOf(entry.getKey()), entry.getValue() == null ? null : String.valueOf(entry.getValue()));
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, ?> first(Map<String, ?> source, String... keys) {
    for (String key : keys) {
      Object value = source.get(key);
      if (value instanceof Map) {
        return (Map<String, ?>) value;
      }
    }
    return null;
  }

  private static String string(Map<?, ?> source, String... keys) {
    for (String key : keys) {
      Object value = source.get(key);
      if (value != null) {
        return String.valueOf(value);
      }
    }
    return null;
  }

  private static boolean bool(Map<?, ?> source, String... keys) {
    for (String key : keys) {
      Object value = source.get(key);
      if (value instanceof Boolean) {
        return (Boolean) value;
      }
      if (value instanceof String) {
        return Boolean.parseBoolean((String) value);
      }
    }
    return false;
  }
}