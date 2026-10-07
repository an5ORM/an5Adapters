import an5.adapters.An5Adapter;
import an5.adapters.An5Aggregate;
import an5.adapters.An5GroupBy;
import an5.adapters.An5Query;
import an5.adapters.An5TableClient;
import an5.adapters.An5ViewClient;
import an5.adapters.base.Dialect;
import an5.adapters.base.JdbcUrls;
import an5.adapters.base.Metadata;
import an5.adapters.base.SqliteVectors;
import an5.adapters.base.Vectors;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * End-to-end exercise of the Java adapter against a real in-memory SQLite database.
 *
 * <p>Covers the parts a compile check cannot reach: identifier quoting per dialect, the
 * pagination forms, generated primary keys, nested relation writes, transaction rollback,
 * and the in-memory vector fallback. Run by {@code scripts/java-sqlite-smoke.js}.
 */
public final class An5AdaptersSmoke {

  private static int failures;

  private An5AdaptersSmoke() {}

  public static void main(String[] args) throws Exception {
    Class.forName("org.sqlite.JDBC");

    checkDialectDetection();
    checkJdbcUrls();
    checkQuoting();
    checkVectors();
    crud();
    relations();
    aggregation();
    transactionRollback();
    viewIsReadOnly();
    vectorFallback();
    sqliteVectorCodecAndPlan();
    sqliteVectorSearch();
    sqliteVectorColumnRoundTrip();

    if (failures > 0) {
      System.out.println("java smoke: " + failures + " check(s) failed");
      System.exit(1);
    }
    System.out.println("java smoke: all checks passed");
  }

  // ─── Units ──────────────────────────────────────────────────────────────────────

  private static void checkDialectDetection() {
    equals("mssql adoc", Dialect.MSSQL, Dialect.detect("Server=db;Database=app"));
    equals("postgres scheme", Dialect.POSTGRES, Dialect.detect("postgresql://localhost/app"));
    equals("sqlite scheme", Dialect.SQLITE, Dialect.detect("sqlite:///tmp/app.db"));
    equals("sqlite suffix", Dialect.SQLITE, Dialect.detect("/tmp/app.sqlite3"));
    equals("sqlite memory", Dialect.SQLITE, Dialect.detect(":memory:"));
  }

  private static void checkJdbcUrls() {
    equals(
        "sqlite url strips wrapper",
        "jdbc:sqlite::memory:",
        JdbcUrls.url("sqlite:///:memory:"));
    equals(
        "postgres url gains jdbc prefix",
        "jdbc:postgresql://localhost/app",
        JdbcUrls.url("postgres://localhost/app"));
    equals(
        "mssql adoc becomes a jdbc url",
        "jdbc:sqlserver://db.internal:1434;databaseName=app;encrypt=true;trustServerCertificate=true",
        JdbcUrls.url("Server=db.internal,1434;Database=app"));
    equals("memory detected", true, JdbcUrls.isMemory("sqlite::memory:"));
    equals("file is not memory", false, JdbcUrls.isMemory("/tmp/app.db"));
    equals("credentials read", "sa", JdbcUrls.credentials("Server=db;User=sa;Password=pw")[0]);
  }

  private static void checkQuoting() {
    equals("mssql identifier", "[name]", Dialect.MSSQL.quoteIdentifier("name"));
    equals("mssql escapes bracket", "[we]]ird]", Dialect.MSSQL.quoteIdentifier("we]ird"));
    equals("sqlite identifier", "\"name\"", Dialect.SQLITE.quoteIdentifier("[name]"));
    equals("postgres escapes quote", "\"we\"\"ird\"", Dialect.POSTGRES.quoteIdentifier("we\"ird"));
    equals(
        "sqlite drops the dbo schema",
        "\"users\"",
        an5.adapters.base.SqlBuilder.quoteTable("dbo.users", Dialect.SQLITE));
    equals(
        "mssql keeps the dbo schema",
        "[dbo].[users]",
        an5.adapters.base.SqlBuilder.quoteTable("dbo.users", Dialect.MSSQL));
    equals(
        "sqlite limit",
        " LIMIT 10 OFFSET 5",
        Dialect.SQLITE.pagination(Integer.valueOf(10), 5, "ORDER BY id"));
    equals(
        "mssql fetch",
        " OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
        Dialect.MSSQL.pagination(Integer.valueOf(10), 5, "ORDER BY id"));
    equals(
        "mssql fetch without order",
        " ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
        Dialect.MSSQL.pagination(Integer.valueOf(10), 5, ""));
  }

  private static void checkVectors() {
    approximately("cosine of identical vectors", 1.0, Vectors.cosineSimilarity(new double[] {1, 2}, new double[] {1, 2}));
    approximately("cosine of opposites", -1.0, Vectors.cosineSimilarity(new double[] {1, 0}, new double[] {-1, 0}));
    equals("cosine of mismatched lengths", 0.0, Vectors.cosineSimilarity(new double[] {1}, new double[] {1, 2}));
    approximately("euclidean", 5.0, Vectors.euclideanDistance(new double[] {0, 0}, new double[] {3, 4}));
    equals("dot", 11.0, Vectors.dotProduct(new double[] {1, 2}, new double[] {3, 4}));
    approximately("dot distance is negated", -11.0, Vectors.distance("dot", new double[] {1, 2}, new double[] {3, 4}));
    equals("vector parses", 3.0, Vectors.parseVector("[1.0, 2.0, 3.0]", 3)[2]);
    equals("vector rejects wrong length", null, Vectors.parseVector("[1.0, 2.0]", 3));
    equals("vector format", "[1.0, 2.5]", Vectors.formatVector(new double[] {1, 2.5}));
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────────

  private static void crud() throws Exception {
    An5Adapter adapter = open();
    try {
      An5TableClient users = adapter.table("User");
      Map<String, Object> created = users.create(map("name", "Ada", "score", 10));
      String id = String.valueOf(created.get("id"));
      equals("generated primary key", true, id.length() > 0);
      equals("create returns the stored row", "Ada", created.get("name"));
      equals("count after create", 1L, users.count(null));

      users.create(map("name", "Grace", "score", 20));
      users.create(map("name", "Alan", "score", 30));

      List<Map<String, Object>> ordered =
          users.findMany(new An5Query().orderBy("score", "desc"));
      equals("orderBy desc", "Alan", ordered.get(0).get("name"));

      List<Map<String, Object>> paged =
          users.findMany(new An5Query().orderBy("score", "asc").skip(1).take(1));
      equals("skip and take", "Grace", paged.get(0).get("name"));
      equals("paged result size", 1, paged.size());

      List<Map<String, Object>> filtered =
          users.findMany(new An5Query().where(map("score", map("gte", 20))));
      equals("gte filter", 2, filtered.size());

      List<Map<String, Object>> searched =
          users.findMany(new An5Query().where(map("name", map("contains", "da"))));
      equals("contains filter", 1, searched.size());
      equals(
          "endsWith filter",
          1,
          users.findMany(new An5Query().where(map("name", map("endsWith", "ce")))).size());

      List<Map<String, Object>> inList =
          users.findMany(new An5Query().where(map("name", map("in", list("Ada", "Grace")))));
      equals("in filter", 2, inList.size());
      equals(
          "empty in matches nothing",
          0,
          users.findMany(new An5Query().where(map("name", map("in", list())))).size());
      equals(
          "empty notIn matches everything",
          3,
          users.findMany(new An5Query().where(map("name", map("notIn", list())))).size());

      List<Map<String, Object>> selected =
          users.findMany(new An5Query().select("name"));
      equals("select projects columns", 1, selected.get(0).size());
      equals("select keeps the named column", "Ada", selected.get(0).get("name"));

      Map<String, Object> updated = users.update(map("id", id), map("score", map("increment", 5)));
      equals("increment operator", 15, ((Number) updated.get("score")).intValue());

      equals(
          "updateMany counts rows",
          3,
          ((Number) users.updateMany(null, map("score", map("increment", 1))).get("count")).intValue());

      equals(
          "upsert updates an existing row",
          "Ada L",
          users.upsert(map("id", id), map("name", "x"), map("name", "Ada L")).get("name"));
      equals("upsert left the row count alone", 3L, users.count(null));
      users.upsert(map("name", "Katherine"), map("name", "Katherine", "score", 1), map("score", 2));
      equals("upsert created the missing row", 4L, users.count(null));

      Map<String, Object> deleted = users.delete(map("id", id));
      equals("delete returns the removed row", "Ada L", deleted.get("name"));
      equals("delete removes exactly one row", 3L, users.count(null));
      equals(
          "deleteMany clears the table",
          3,
          ((Number) users.deleteMany(null).get("count")).intValue());
      equals("table is empty", 0L, users.count(null));
    } finally {
      adapter.close();
    }
  }

  // ─── Relations ──────────────────────────────────────────────────────────────────

  private static void relations() throws Exception {
    An5Adapter adapter = open();
    try {
      Map<String, Object> ada = adapter.table("User").create(map("name", "Ada", "score", 1));
      String adaId = String.valueOf(ada.get("id"));
      adapter.table("Post").create(map("title", "first", "userId", adaId));
      adapter.table("Post").create(map("title", "second", "userId", adaId));
      Map<String, Object> grace = adapter.table("User").create(map("name", "Grace", "score", 2));
      adapter.table("Post").create(map("title", "third", "userId", grace.get("id")));

      Map<String, Object> include = new LinkedHashMap<String, Object>();
      include.put("posts", Boolean.TRUE);
      include.put("_count", Boolean.TRUE);
      List<Map<String, Object>> rows =
          adapter.table("User").findMany(new An5Query().orderBy("name", "asc").include(include));

      Map<String, Object> first = rows.get(0);
      equals("rows are ordered as asked", "Ada", first.get("name"));
      equals("many relation eager-loaded", 2, ((List<?>) first.get("posts")).size());
      equals(
          "eager-loaded rows are the related models",
          "first",
          ((Map<?, ?>) ((List<?>) first.get("posts")).get(0)).get("title"));
      equals(
          "relation count eager-loaded",
          2L,
          ((Number) ((Map<?, ?>) first.get("_count")).get("posts")).longValue());

      Map<String, Object> nestedCreate = new LinkedHashMap<String, Object>();
      nestedCreate.put("create", map("title", "third"));
      Map<String, Object> withPosts = new LinkedHashMap<String, Object>();
      withPosts.put("posts", nestedCreate);
      Map<String, Object> nested = new LinkedHashMap<String, Object>(map("name", "Barbara"));
      nested.putAll(withPosts);
      adapter.table("User").create(nested);
      equals("nested relation create writes the child", 4L, adapter.table("Post").count(null));
    } finally {
      adapter.close();
    }
  }

  // ─── Aggregation ────────────────────────────────────────────────────────────────

  private static void aggregation() throws Exception {
    An5Adapter adapter = open();
    try {
      An5TableClient users = adapter.table("User");
      users.create(map("name", "Ada", "score", 10));
      users.create(map("name", "Grace", "score", 20));
      users.create(map("name", "Alan", "score", 30));

      Map<String, Object> totals = users.aggregate(new An5Aggregate().count().sum("score").avg("score"));
      equals("aggregate count", 3L, ((Number) totals.get("_count")).longValue());
      equals("aggregate sum", 60.0, ((Number) totals.get("_sum_score")).doubleValue());
      equals("aggregate avg", 20.0, ((Number) totals.get("_avg_score")).doubleValue());

      List<Map<String, Object>> groups =
          users.groupBy(new An5GroupBy().by("name").sum("score"));
      equals("groupBy row per group", 3, groups.size());
      equals("groupBy counts", 1L, ((Number) groups.get(0).get("_count")).longValue());

      equals("groupBy needs a by column", "groupBy requires at least one 'by' column",
          failure(new Runnable() {
            @Override
            public void run() {
              try {
                users.groupBy(new An5GroupBy());
              } catch (Exception error) {
                throw new RuntimeException(error.getMessage());
              }
            }
          }));
    } finally {
      adapter.close();
    }
  }

  // ─── Transactions ───────────────────────────────────────────────────────────────

  private static void transactionRollback() throws Exception {
    final An5Adapter adapter = open();
    try {
      adapter.table("User").create(map("name", "outside"));
      try {
        adapter.transaction(
            new An5Adapter.TransactionWork<Void>() {
              @Override
              public Void run(An5Adapter scoped) throws java.sql.SQLException {
                scoped.table("User").create(map("name", "inside"));
                throw new IllegalStateException("rollback");
              }
            });
        equals("transaction rethrows", false, true);
      } catch (IllegalStateException expected) {
        equals("transaction rethrows the cause", "rollback", expected.getMessage());
      }
      equals("rollback discarded the inner insert", 1L, adapter.table("User").count(null));

      adapter.transaction(
          new An5Adapter.TransactionWork<Void>() {
            @Override
            public Void run(An5Adapter scoped) throws java.sql.SQLException {
              scoped.table("User").create(map("name", "committed"));
              return null;
            }
          });
      equals("commit kept the insert", 2L, adapter.table("User").count(null));
    } finally {
      adapter.close();
    }
  }

  private static void viewIsReadOnly() throws Exception {
    An5Adapter adapter = open();
    try {
      adapter.table("User").create(map("name", "Ada", "score", 1));
      An5ViewClient view = adapter.view("User");
      equals("view reads", 1, view.findMany().size());
      equals("view counts", 1L, view.count());
      equals(
          "view refuses writes",
          true,
          failure(new Runnable() {
            @Override
            public void run() {
              try {
                new An5Adapter(":memory:").view("User").create(map("name", "x"));
              } catch (UnsupportedOperationException expected) {
                throw new RuntimeException("read-only");
              } catch (Exception error) {
                throw new RuntimeException(error.getMessage());
              }
            }
          }).equals("read-only"));
    } finally {
      adapter.close();
    }
  }

  private static void vectorFallback() throws Exception {
    An5Adapter adapter = open();
    try {
      An5TableClient docs = adapter.table("Document");
      // Orthogonal to the query: cosine distance is scale-invariant, so a longer vector
      // pointing the same way would still rank as the closest.
      docs.create(map("title", "far", "embedding", "[0.0, 1.0]"));
      docs.create(map("title", "near", "embedding", "[1.0, 0.1]"));
      docs.create(map("title", "no vector", "embedding", null));

      List<Map<String, Object>> hits =
          docs.vectorSearch(new double[] {1, 0}, Integer.valueOf(2), null, "embedding", "cosine");
      equals("vector search skips rows without a vector", 2, hits.size());
      equals("vector search orders by distance", "near", hits.get(0).get("title"));
      equals("vector search reports the distance", true, hits.get(0).containsKey("distance"));
    } finally {
      adapter.close();
    }
  }

  /**
   * SQLite vector codec and strategy plan.
   *
   * <p>The docstring in {@code SqliteVectors} is the shared specification every runtime
   * implements; test/sqlite-vector.test.js (TypeScript) is the mirror of this coverage.
   */
  private static void sqliteVectorCodecAndPlan() {
    System.out.println("\n[sqlite vector codec]");
    byte[] encoded = SqliteVectors.encodeVector(new double[] {1, -2, 0.5});
    equals("float32 blob length", Integer.valueOf(12), Integer.valueOf(encoded.length));
    equals(
        "little-endian 1.0",
        "0,0,128,63",
        (encoded[0] & 0xff) + "," + (encoded[1] & 0xff) + "," + (encoded[2] & 0xff) + ","
            + (encoded[3] & 0xff));
    equals(
        "blob round trip",
        "[1.0, -2.0, 0.5]",
        java.util.Arrays.toString(SqliteVectors.decodeVector(encoded, 0)));
    equals(
        "legacy JSON text",
        "[1.0, 0.0, 0.0]",
        java.util.Arrays.toString(SqliteVectors.decodeVector("[1, 0, 0]", 0)));
    equals(
        "a float array reads back",
        "[1.0, 2.0]",
        java.util.Arrays.toString(SqliteVectors.decodeVector(new float[] {1, 2}, 0)));
    equals(
        "a mismatched dimension is rejected",
        null,
        SqliteVectors.decodeVector(encoded, Integer.valueOf(5)));
    equals("a partial blob is rejected", null, SqliteVectors.decodeVectorBytes(new byte[3], 0));
    equals("text that is not JSON is rejected", null, SqliteVectors.decodeVector("nope", 0));
    equals("a null vector stays null", null, SqliteVectors.decodeVector(null, 0));
    equals(
        "cosine of a vector with itself",
        0.0,
        Vectors.distance("cosine", new double[] {1, 0}, new double[] {1, 0}));
    equals(
        "euclidean distance",
        5.0,
        Vectors.distance("euclidean", new double[] {0, 3}, new double[] {4, 0}));
    equals(
        "dot distance is negated",
        -10.0,
        Vectors.distance("dot", new double[] {1, 2}, new double[] {2, 4}));
    equals("a VECTOR column", true, SqliteVectors.isVectorField("VECTOR(3)"));
    equals("a TEXT column", false, SqliteVectors.isVectorField("TEXT"));

    System.out.println("\n[sqlite vector strategy plan]");
    SqliteVectors.Capabilities all = new SqliteVectors.Capabilities(true, true, true);
    equals(
        "sqlite-vec and the driver function come first",
        "[sqlite-vec, udf]",
        SqliteVectors.planStrategies(all, "BLOB", null).toString());
    // A BLOB column has no JSON to read, so json_each could only produce NULLs.
    equals(
        "a BLOB column drops the JSON strategy",
        "[]",
        SqliteVectors.planStrategies(
            new SqliteVectors.Capabilities(false, false, true), "BLOB", null).toString());
    equals(
        "a TEXT column keeps the JSON strategy",
        "[sql]",
        SqliteVectors.planStrategies(
            new SqliteVectors.Capabilities(false, false, true), "TEXT", null).toString());
    equals(
        "a pinned strategy wins",
        "[udf]",
        SqliteVectors.planStrategies(all, "BLOB", "udf").toString());
    equals(
        "memory is the caller's own path",
        "[]",
        SqliteVectors.planStrategies(all, "BLOB", "memory").toString());
    equals(
        "an unknown metric falls back to cosine",
        "an5_vec_cosine",
        SqliteVectors.distanceFunction("udf", "nonsense"));

    System.out.println("\n[sqlite vector ranking sql]");
    List<Object> bind = new ArrayList<Object>();
    String udf =
        SqliteVectors.buildRankingQuery(
            "udf", "cosine", "[documents]", "[embedding]", new double[] {1, 0, 0}, 5,
            " WHERE [id] = ?", "?", bind);
    equals(
        "one WHERE in the ranked subquery",
        Integer.valueOf(1),
        Integer.valueOf(countOf(udf.substring(0, udf.indexOf("an5_ranked")), " WHERE ")));
    equals(
        "the tail stays inside the subquery",
        true,
        udf.indexOf("WHERE [id] = ?") < udf.indexOf("an5_ranked"));
    equals("a NULL distance is filtered", true, udf.contains("WHERE distance IS NOT NULL"));
    equals("the query vector is bound as bytes", true, bind.get(0) instanceof byte[]);
    bind.clear();
    String json =
        SqliteVectors.buildRankingQuery(
            "sql", "cosine", "[documents]", "[embedding]", new double[] {1, 0, 0}, 5, "", "?", bind);
    equals("json_each reads the vector as text", "[1.0, 0.0, 0.0]", bind.get(0));
    equals("the JSON path walks the column", true, json.contains("json_each"));
  }

  private static int countOf(String haystack, String needle) {
    int count = 0;
    int index = haystack.indexOf(needle);
    while (index >= 0) {
      count++;
      index = haystack.indexOf(needle, index + needle.length());
    }
    return count;
  }

  /**
   * SQLite ranks a {@code VECTOR(n)} column inside the database.
   *
   * <p>Plain JDBC cannot register a user function or load an extension, so a stock adapter
   * reaches the {@code json_each} strategy for a JSON text column and the in-memory fallback
   * for a float32 BLOB one.
   */
  private static void sqliteVectorSearch() throws Exception {
    System.out.println("\n[sqlite vector search -> json_each on a TEXT column]");
    An5Adapter adapter = open();
    try {
      An5TableClient docs = adapter.table("Document");
      docs.create(map("title", "d1", "embedding", "[1.0, 0.0, 0.0]"));
      docs.create(map("title", "d2", "embedding", "[0.8, 0.2, 0.0]"));
      docs.create(map("title", "d3", "embedding", "[0.0, 1.0, 0.0]"));
      // A row with another dimension must never rank against a 3-dimension query.
      docs.create(map("title", "d4", "embedding", "[1.0, 0.0, 0.0, 1.0]"));
      docs.create(map("title", "d5", "embedding", null));

      for (String metric : new String[] {"cosine", "euclidean", "dot"}) {
        List<Map<String, Object>> hits =
            docs.vectorSearch(new double[] {1, 0, 0}, Integer.valueOf(9), null, "embedding", metric);
        equals(metric + ": row order", "d1,d2,d3", titles(hits));
        equals(metric + ": the distance is a number", true, hits.get(0).get("distance") instanceof Double);
      }

      System.out.println("\n[sqlite vector search -> in-memory on a BLOB column]");
      An5Adapter blobAdapter = openWithBlobDocuments();
      try {
        List<Map<String, Object>> hits =
            blobAdapter
                .table("Document")
                .vectorSearch(new double[] {1, 0, 0}, Integer.valueOf(9), null, "embedding", "cosine");
        equals("row order", "d1,d2,d3", titles(hits));
        equals("the vector decodes to numbers", true, hits.get(0).get("embedding") instanceof double[]);
      } finally {
        blobAdapter.close();
      }

      System.out.println("\n[sqlite vector search -> a pinned strategy]");
      An5Adapter pinned = open();
      try {
        An5TableClient pinnedDocs = pinned.table("Document");
        pinnedDocs.create(map("title", "d1", "embedding", "[1.0, 0.0, 0.0]"));
        pinnedDocs.create(map("title", "d2", "embedding", "[0.8, 0.2, 0.0]"));
        pinnedDocs.create(map("title", "d3", "embedding", "[0.0, 1.0, 0.0]"));
        // `memory` yields no query plan, so the rows are scored in Java instead.
        pinned.setVectorStrategy("memory");
        List<Map<String, Object>> hits =
            pinned
                .table("Document")
                .vectorSearch(new double[] {1, 0, 0}, Integer.valueOf(9), null, "embedding", "cosine");
        equals("the memory fallback ranks correctly", "d1,d2,d3", titles(hits));
      } finally {
        pinned.close();
      }
    } finally {
      adapter.close();
    }
  }

  private static String titles(List<Map<String, Object>> rows) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < rows.size(); i++) {
      if (i > 0) {
        out.append(',');
      }
      out.append(rows.get(i).get("title"));
    }
    return out.toString();
  }

  /** A database whose vector column holds float32 BLOBs, as {@code VECTOR(n)} now maps to. */
  private static An5Adapter openWithBlobDocuments() throws Exception {
    Metadata.setAdapterMetadata(blobMetadata());
    An5Adapter adapter = new An5Adapter(":memory:");
    adapter.executeRaw("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding BLOB)");
    double[][] vectors = {{1, 0, 0}, {0.8, 0.2, 0}, {0, 1, 0}};
    for (int i = 0; i < vectors.length; i++) {
      adapter.executeRaw(
          "INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)",
          "d" + (i + 1),
          "d" + (i + 1),
          SqliteVectors.encodeVector(vectors[i]));
    }
    // A row with another dimension must never rank against a 3-dimension query.
    adapter.executeRaw(
        "INSERT INTO documents (id, title, embedding) VALUES ('d4', 'd4', ?)",
        SqliteVectors.encodeVector(new double[] {1, 0, 0, 1}));
    return adapter;
  }

  private static Map<String, Object> blobMetadata() {
    Map<String, Object> metadata = metadata();
    @SuppressWarnings("unchecked")
    Map<String, Object> fields = (Map<String, Object>) metadata.get("modelFields");
    Map<String, Object> embedding = new LinkedHashMap<String, Object>();
    embedding.put("name", "embedding");
    embedding.put("type", "number[] | string");
    embedding.put("sql", "VECTOR(3)");
    embedding.put("isOptional", Boolean.TRUE);
    embedding.put("hasDefault", Boolean.FALSE);
    embedding.put("isId", Boolean.FALSE);
    fields.put("Document", list(field("id", true), field("title", false), embedding));
    return metadata;
  }

  /** A {@code VECTOR(n)} column stores float32 bytes and reads back as numbers. */
  private static void sqliteVectorColumnRoundTrip() throws Exception {
    System.out.println("\n[sqlite vector column round trip]");
    An5Adapter adapter = openWithBlobDocuments();
    try {
      An5TableClient docs = adapter.table("Document");
      Map<String, Object> written =
          docs.create(
              map("id", "d9", "title", "written", "embedding", new double[] {0.25, 0.5, 1.0}));
      equals(
          "create returns numbers",
          "[0.25, 0.5, 1.0]",
          java.util.Arrays.toString((double[]) written.get("embedding")));

      List<Map<String, Object>> stored =
          adapter.exec("SELECT typeof(embedding) AS t FROM documents WHERE id = 'd9'");
      equals("a double[] is written as a BLOB", "blob", stored.get(0).get("t"));

      List<Map<String, Object>> rows = docs.findMany(new An5Query().where(map("id", "d9")));
      equals(
          "findMany returns numbers",
          "[0.25, 0.5, 1.0]",
          java.util.Arrays.toString((double[]) rows.get(0).get("embedding")));

      docs.update(map("id", "d1"), map("embedding", new double[] {0.5, 0.5, 0}));
      List<Map<String, Object>> updated = docs.findMany(new An5Query().where(map("id", "d1")));
      equals(
          "update encodes",
          "[0.5, 0.5, 0.0]",
          java.util.Arrays.toString((double[]) updated.get(0).get("embedding")));

      docs.updateMany(map("id", "d2"), map("embedding", new double[] {0, 0, 1}));
      List<Map<String, Object>> many = docs.findMany(new An5Query().where(map("id", "d2")));
      equals(
          "updateMany encodes",
          "[0.0, 0.0, 1.0]",
          java.util.Arrays.toString((double[]) many.get(0).get("embedding")));

      equals(
          "a non-vector column is untouched",
          "d1",
          String.valueOf(docs.findMany(new An5Query().where(map("id", "d1"))).get(0).get("title")));
    } finally {
      adapter.close();
    }
  }

  // ─── Harness ────────────────────────────────────────────────────────────────────

  /** A fresh in-memory database with the fixture schema and metadata registered. */
  private static An5Adapter open() {
    Metadata.setAdapterMetadata(metadata());
    An5Adapter adapter = new An5Adapter(":memory:");
    try {
      adapter.executeRaw(
          "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, score INTEGER, embedding TEXT)");
      adapter.executeRaw("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding TEXT)");
      adapter.executeRaw("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, userId TEXT)");
    } catch (Exception error) {
      throw new RuntimeException(error);
    }
    return adapter;
  }

  private static Map<String, Object> metadata() {
    Map<String, Object> fields = new LinkedHashMap<String, Object>();
    fields.put("User", list(field("id", true), field("name", false), field("score", false)));
    fields.put("Post", list(field("id", true), field("title", false), field("userId", false)));
    fields.put("Document", list(field("id", true), field("title", false), field("embedding", false)));

    Map<String, Object> userPosts = new LinkedHashMap<String, Object>();
    userPosts.put("modelName", "Post");
    userPosts.put("relationType", "many");
    userPosts.put("foreignKey", "userId");
    userPosts.put("localKey", "id");
    Map<String, Object> userRelations = new LinkedHashMap<String, Object>();
    userRelations.put("posts", userPosts);

    Map<String, Object> relations = new LinkedHashMap<String, Object>();
    relations.put("User", userRelations);

    Map<String, Object> tables = new LinkedHashMap<String, Object>();
    tables.put("User", "users");
    tables.put("Post", "posts");
    tables.put("Document", "documents");

    Map<String, Object> metadata = new LinkedHashMap<String, Object>();
    metadata.put("modelToTable", tables);
    metadata.put("modelFields", fields);
    metadata.put("relationMap", relations);
    return metadata;
  }

  private static Map<String, Object> field(String name, boolean id) {
    Map<String, Object> field = new LinkedHashMap<String, Object>();
    field.put("name", name);
    field.put("type", "string");
    field.put("sql", "NVARCHAR(255)");
    field.put("isOptional", Boolean.FALSE);
    field.put("hasDefault", Boolean.FALSE);
    field.put("isId", Boolean.valueOf(id));
    return field;
  }

  /** A row map from alternating key/value pairs, in declaration order. */
  private static Map<String, Object> map(Object... pairs) {
    Map<String, Object> map = new LinkedHashMap<String, Object>();
    for (int i = 0; i + 1 < pairs.length; i += 2) {
      map.put(String.valueOf(pairs[i]), pairs[i + 1]);
    }
    return map;
  }

  private static List<Object> list(Object... values) {
    List<Object> list = new ArrayList<Object>();
    for (Object value : values) {
      list.add(value);
    }
    return list;
  }

  private static String failure(Runnable body) {
    try {
      body.run();
      return "<no failure>";
    } catch (RuntimeException error) {
      return error.getMessage();
    }
  }

  /** Compares within a tolerance, so a floating-point result is not a rounding failure. */
  private static void approximately(String what, double expected, double actual) {
    if (Math.abs(expected - actual) <= 1e-9) {
      System.out.println("ok   " + what);
      return;
    }
    failures++;
    System.out.println("FAIL " + what + ": expected " + expected + ", got " + actual);
  }

  private static void equals(String what, Object expected, Object actual) {
    boolean same = expected == null ? actual == null : expected.equals(actual);
    if (same) {
      System.out.println("ok   " + what);
      return;
    }
    failures++;
    System.out.println("FAIL " + what + ": expected " + expected + ", got " + actual);
  }
}