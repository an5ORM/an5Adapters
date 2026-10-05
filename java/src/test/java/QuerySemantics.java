import an5.adapters.base.Dialect;
import an5.adapters.base.SqlBuilder;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs the shared query contract in {@code test/fixtures/query-semantics.json} through the
 * Java SQL builder and a real SQLite database.
 *
 * <p>The same fixture gates the TypeScript, Python and Go builders, which is the point: a
 * where tree that means one thing in one client and another in the next is a bug in the
 * client, and only a shared fixture catches it.
 *
 * <p>Reads the fixture path from {@code args[0]}, or from {@code ../test/fixtures} when run
 * from the adapter directory.
 */
public final class QuerySemantics {

  private QuerySemantics() {}

  public static void main(String[] args) throws Exception {
    String fixturePath =
        args.length > 0 ? args[0] : "../test/fixtures/query-semantics.json";
    Map<String, Object> fixture = Json.asObject(Json.parse(read(fixturePath)));

    List<Object> rows = Json.asList(fixture.get("rows"));
    int failures = 0;
    for (Object entry : Json.asList(fixture.get("cases"))) {
      Map<String, Object> testCase = Json.asObject(entry);
      String name = String.valueOf(testCase.get("name"));
      Map<String, Object> where = Json.asObject(testCase.get("where"));
      List<Object> expected = Json.asList(testCase.get("ids"));
      try {
        List<Long> actual = run(rows, where);
        List<Long> expectedIds = new ArrayList<Long>();
        for (Object id : expected) {
          expectedIds.add(((Number) id).longValue());
        }
        if (!actual.equals(expectedIds)) {
          System.out.println("FAIL " + name + ": expected " + expectedIds + ", got " + actual);
          failures++;
        } else {
          System.out.println("ok   " + name);
        }
      } catch (Exception error) {
        System.out.println("FAIL " + name + ": " + error);
        failures++;
      }
    }

    if (failures > 0) {
      System.out.println("java query contract: " + failures + " case(s) failed");
      System.exit(1);
    }
    System.out.println("java query contract: all cases passed");
  }

  private static List<Long> run(List<Object> rows, Map<String, Object> where) throws Exception {
    Connection connection = DriverManager.getConnection("jdbc:sqlite::memory:");
    try {
      Statement statement = connection.createStatement();
      statement.execute("CREATE TABLE users (id INTEGER, score INTEGER)");
      for (Object entry : rows) {
        Map<String, Object> row = Json.asObject(entry);
        statement.execute(
            "INSERT INTO users VALUES ("
                + ((Number) row.get("id")).longValue()
                + ", "
                + ((Number) row.get("score")).longValue()
                + ")");
      }

      Map<String, Object> params = new LinkedHashMap<String, Object>();
      SqlBuilder.Where clause = SqlBuilder.parseWhere(where, Dialect.SQLITE, params, "");
      List<Object> values = new ArrayList<Object>(params.values());
      String sql =
          "SELECT id FROM users"
              + (clause.isEmpty() ? "" : " WHERE " + clause.sql)
              + " ORDER BY id";

      java.sql.PreparedStatement prepared = connection.prepareStatement(sql);
      for (int i = 0; i < values.size(); i++) {
        prepared.setObject(i + 1, values.get(i));
      }
      ResultSet results = prepared.executeQuery();
      List<Long> ids = new ArrayList<Long>();
      while (results.next()) {
        ids.add(results.getLong(1));
      }
      results.close();
      prepared.close();
      return ids;
    } finally {
      connection.close();
    }
  }

  private static String read(String path) throws IOException {
    return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
  }
}