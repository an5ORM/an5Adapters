import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader for the test suite.
 *
 * <p>The adapter itself has no JSON dependency — it never parses a document, it only ever
 * reads and writes vector literals — so pulling one in for production code to satisfy a
 * test would be the wrong trade. This reads exactly the subset the shared query-semantics
 * fixture uses: objects, arrays, strings, numbers, booleans and null.
 */
final class Json {

  private final String source;
  private int position;

  private Json(String source) {
    this.source = source;
  }

  static Object parse(String text) {
    Json parser = new Json(text);
    parser.skipWhitespace();
    Object value = parser.readValue();
    parser.skipWhitespace();
    return value;
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> asObject(Object value) {
    return value instanceof Map ? (Map<String, Object>) value : new LinkedHashMap<String, Object>();
  }

  @SuppressWarnings("unchecked")
  static List<Object> asList(Object value) {
    return value instanceof List ? (List<Object>) value : new ArrayList<Object>();
  }

  private Object readValue() {
    skipWhitespace();
    char ch = peek();
    switch (ch) {
      case '{':
        return readObject();
      case '[':
        return readArray();
      case '"':
        return readString();
      case 't':
        expect("true");
        return Boolean.TRUE;
      case 'f':
        expect("false");
        return Boolean.FALSE;
      case 'n':
        expect("null");
        return null;
      default:
        return readNumber();
    }
  }

  private Map<String, Object> readObject() {
    Map<String, Object> object = new LinkedHashMap<String, Object>();
    position++;
    skipWhitespace();
    if (peek() == '}') {
      position++;
      return object;
    }
    while (true) {
      skipWhitespace();
      String key = readString();
      skipWhitespace();
      position++; // ':'
      object.put(key, readValue());
      skipWhitespace();
      char ch = peek();
      position++;
      if (ch == '}') {
        return object;
      }
    }
  }

  private List<Object> readArray() {
    List<Object> array = new ArrayList<Object>();
    position++;
    skipWhitespace();
    if (peek() == ']') {
      position++;
      return array;
    }
    while (true) {
      array.add(readValue());
      skipWhitespace();
      char ch = peek();
      position++;
      if (ch == ']') {
        return array;
      }
    }
  }

  private String readString() {
    StringBuilder out = new StringBuilder();
    position++;
    while (true) {
      char ch = source.charAt(position++);
      if (ch == '"') {
        return out.toString();
      }
      if (ch != '\\') {
        out.append(ch);
        continue;
      }
      char escaped = source.charAt(position++);
      switch (escaped) {
        case 'n':
          out.append('\n');
          break;
        case 't':
          out.append('\t');
          break;
        case 'r':
          out.append('\r');
          break;
        case 'b':
          out.append('\b');
          break;
        case 'f':
          out.append('\f');
          break;
        case 'u':
          out.append((char) Integer.parseInt(source.substring(position, position + 4), 16));
          position += 4;
          break;
        default:
          out.append(escaped);
      }
    }
  }

  private Object readNumber() {
    int start = position;
    while (position < source.length() && "+-.eE0123456789".indexOf(source.charAt(position)) >= 0) {
      position++;
    }
    String text = source.substring(start, position);
    if (text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0) {
      return Long.valueOf(text);
    }
    return Double.valueOf(text);
  }

  private void expect(String literal) {
    if (!source.startsWith(literal, position)) {
      throw new IllegalArgumentException("expected " + literal + " at offset " + position);
    }
    position += literal.length();
  }

  private char peek() {
    return position < source.length() ? source.charAt(position) : '\0';
  }

  private void skipWhitespace() {
    while (position < source.length() && Character.isWhitespace(source.charAt(position))) {
      position++;
    }
  }
}