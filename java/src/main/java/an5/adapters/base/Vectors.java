package an5.adapters.base;

/** The distance metrics {@code vectorSearch} supports, and the math behind them. */
public final class Vectors {

  private Vectors() {}

  /** Cosine similarity in {@code [-1, 1]}; {@code 0} when the lengths differ or either side is empty. */
  public static double cosineSimilarity(double[] left, double[] right) {
    if (left == null || right == null || left.length != right.length || left.length == 0) {
      return 0;
    }
    double dot = 0;
    double leftMagnitude = 0;
    double rightMagnitude = 0;
    for (int i = 0; i < left.length; i++) {
      dot += left[i] * right[i];
      leftMagnitude += left[i] * left[i];
      rightMagnitude += right[i] * right[i];
    }
    if (leftMagnitude == 0 || rightMagnitude == 0) {
      return 0;
    }
    return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  }

  /** L2 distance; {@code 0} when the lengths differ or either side is empty. */
  public static double euclideanDistance(double[] left, double[] right) {
    if (left == null || right == null || left.length != right.length || left.length == 0) {
      return 0;
    }
    double sum = 0;
    for (int i = 0; i < left.length; i++) {
      double difference = left[i] - right[i];
      sum += difference * difference;
    }
    return Math.sqrt(sum);
  }

  /** Inner product; {@code 0} when the lengths differ or either side is empty. */
  public static double dotProduct(double[] left, double[] right) {
    if (left == null || right == null || left.length != right.length) {
      return 0;
    }
    double sum = 0;
    for (int i = 0; i < left.length; i++) {
      sum += left[i] * right[i];
    }
    return sum;
  }

  /**
   * The distance to sort ascending by, for a metric name.
   *
   * <p>Cosine similarity is turned into a distance as {@code 1 - similarity} and dot
   * product is negated, so that ascending order means "closer" for every metric and the
   * caller never has to remember which ones are inverted.
   */
  public static double distance(String metric, double[] left, double[] right) {
    if ("dot".equalsIgnoreCase(metric)) {
      return -dotProduct(left, right);
    }
    if ("euclidean".equalsIgnoreCase(metric)) {
      return euclideanDistance(left, right);
    }
    return 1 - cosineSimilarity(left, right);
  }

  /**
   * Reads a stored vector back out of a cell.
   *
   * <p>All three vector stores AN5 targets hand the column back as text — SQL Server's
   * {@code VECTOR}, PostgreSQL's {@code vector}, and SQLite's JSON blob — so the in-memory
   * fallback parses the same {@code [0.1, 0.2]} form. A row whose length does not match the
   * query vector yields {@code null} rather than a silently wrong score.
   *
   * @param expectedLength the query vector's length, or {@code 0} to accept any length
   */
  public static double[] parseVector(Object value, int expectedLength) {
    if (value == null) {
      return null;
    }
    if (value instanceof double[]) {
      double[] copy = ((double[]) value).clone();
      return expectedLength > 0 && copy.length != expectedLength ? null : copy;
    }
    String text = String.valueOf(value).trim();
    int open = text.indexOf('[');
    int close = text.lastIndexOf(']');
    if (open < 0 || close <= open) {
      return null;
    }
    String body = text.substring(open + 1, close).trim();
    if (body.isEmpty()) {
      return null;
    }
    String[] parts = body.split(",");
    double[] parsed = new double[parts.length];
    for (int i = 0; i < parts.length; i++) {
      try {
        parsed[i] = Double.parseDouble(parts[i].trim());
      } catch (NumberFormatException error) {
        return null;
      }
    }
    if (parsed.length == 0 || (expectedLength > 0 && parsed.length != expectedLength)) {
      return null;
    }
    return parsed;
  }

  /** Renders a vector the way the vector stores expect it, as {@code [0.1, 0.2]}. */
  public static String formatVector(double[] vector) {
    StringBuilder out = new StringBuilder("[");
    for (int i = 0; i < vector.length; i++) {
      if (i > 0) {
        out.append(", ");
      }
      out.append(vector[i]);
    }
    return out.append(']').toString();
  }
}