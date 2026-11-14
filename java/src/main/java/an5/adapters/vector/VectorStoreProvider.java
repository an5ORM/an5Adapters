package an5.adapters.vector;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Unified vector database client for AN5 ORM (Java) using {@code java.net.HttpURLConnection}.
 * Supports NBase, Qdrant, Chroma, Pinecone, Weaviate, and Milvus with zero external dependencies,
 * fully compatible with Java 8 / Android bytecode targets.
 */
public final class VectorStoreProvider {

    public enum Kind {
        NBASE("nbase"),
        QDRANT("qdrant"),
        CHROMA("chroma"),
        PINECONE("pinecone"),
        WEAVIATE("weaviate"),
        MILVUS("milvus");

        private final String id;

        Kind(String id) {
            this.id = id;
        }

        public String id() {
            return id;
        }
    }

    public static final class VectorRecord {
        public final String id;
        public final List<Double> vector;
        public final Map<String, Object> metadata;

        public VectorRecord(String id, List<Double> vector, Map<String, Object> metadata) {
            this.id = id;
            this.vector = vector;
            this.metadata = metadata;
        }
    }

    public static final class SearchHit {
        public final String id;
        public final double distance;
        public final Map<String, Object> metadata;

        public SearchHit(String id, double distance, Map<String, Object> metadata) {
            this.id = id;
            this.distance = distance;
            this.metadata = metadata;
        }
    }

    @FunctionalInterface
    public interface Transport {
        String request(String method, String url, Map<String, String> headers, String body, Duration timeout)
                throws IOException, InterruptedException;
    }

    private static final Transport DEFAULT_TRANSPORT = (method, urlStr, headers, body, timeout) -> {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        int timeoutMs = (int) Math.min(timeout.toMillis(), (long) Integer.MAX_VALUE);
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "application/json");
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                conn.setRequestProperty(entry.getKey(), entry.getValue());
            }
        }
        if (body != null && !body.isEmpty()) {
            conn.setDoOutput(true);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
                os.flush();
            }
        }
        int code = conn.getResponseCode();
        InputStream is = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
        if (is == null) {
            if (code >= 400) {
                throw new IOException("HTTP " + code + " from " + urlStr);
            }
            return "";
        }
        StringBuilder resp = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            char[] buf = new char[4096];
            int n;
            while ((n = reader.read(buf)) != -1) {
                resp.append(buf, 0, n);
            }
        }
        if (code >= 400) {
            throw new IOException("HTTP " + code + " from " + urlStr + ": " + resp.toString());
        }
        return resp.toString();
    };

    private final Kind kind;
    private final String endpoint;
    private final String collection;
    private final String namespace;
    private final String tenant;
    private final String database;
    private final String dbName;
    private final String token;
    private final Duration timeout;
    private final Transport transport;
    private final Map<String, String> chromaIds = new HashMap<>();

    private VectorStoreProvider(
            Kind kind,
            String endpoint,
            String collection,
            String namespace,
            String tenant,
            String database,
            String dbName,
            String token,
            Duration timeout,
            Transport transport) {
        this.kind = kind;
        this.endpoint = endpoint;
        this.collection = collection;
        this.namespace = namespace;
        this.tenant = tenant;
        this.database = database;
        this.dbName = dbName;
        this.token = token;
        this.timeout = timeout;
        this.transport = transport != null ? transport : DEFAULT_TRANSPORT;
    }

    public static Kind detectProvider(String connStr) {
        if (connStr == null) return null;
        String lower = connStr.trim().toLowerCase(Locale.ROOT);
        for (Kind k : Kind.values()) {
            if (lower.startsWith(k.id + ":")) return k;
        }
        return null;
    }

    public static boolean isVectorConnectionString(String connStr) {
        return detectProvider(connStr) != null;
    }

    public static VectorStoreProvider fromConnectionString(String connStr) {
        return fromConnectionString(connStr, DEFAULT_TRANSPORT);
    }

    public static VectorStoreProvider fromConnectionString(String connStr, Transport transport) {
        Kind kind = detectProvider(connStr);
        if (kind == null) {
            throw new IllegalArgumentException("Unsupported vector database connection string: " + connStr);
        }
        String raw = connStr.trim();
        String rest = raw.substring(kind.id.length() + 1);
        if (rest.startsWith("//")) rest = rest.substring(2);
        String pathPart = rest;
        String queryPart = "";
        int qIdx = rest.indexOf('?');
        if (qIdx >= 0) {
            pathPart = rest.substring(0, qIdx);
            queryPart = rest.substring(qIdx + 1);
        }
        Map<String, String> params = new HashMap<>();
        for (String pair : queryPart.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            if (eq > 0) {
                params.put(pair.substring(0, eq), pair.substring(eq + 1));
            }
        }
        String host = pathPart.trim().replaceAll("/+$", "");
        String pathParam = null;
        if (!host.isEmpty() && !host.contains("://")) {
            int slash = host.indexOf('/');
            if (slash >= 0) {
                pathParam = host.substring(slash + 1);
                host = host.substring(0, slash);
            }
        }
        String defaultScheme = kind == Kind.PINECONE ? "https" : "http";
        String fallbackHost;
        switch (kind) {
            case NBASE:
                fallbackHost = "localhost:1307";
                break;
            case QDRANT:
                fallbackHost = "localhost:6333";
                break;
            case CHROMA:
                fallbackHost = "localhost:8000";
                break;
            case PINECONE:
                fallbackHost = "localhost";
                break;
            case WEAVIATE:
                fallbackHost = "localhost:8080";
                break;
            case MILVUS:
                fallbackHost = "localhost:19530";
                break;
            default:
                fallbackHost = "localhost";
                break;
        }
        String endpoint = host.isEmpty()
                ? defaultScheme + "://" + fallbackHost
                : (host.contains("://") ? host : defaultScheme + "://" + host);
        String defaultCol = kind == Kind.WEAVIATE ? "An5Vector" : "an5";
        String col = params.getOrDefault("collection",
                params.getOrDefault("className", pathParam != null && !pathParam.isEmpty() ? pathParam : defaultCol));
        String ns = params.getOrDefault("namespace", kind == Kind.PINECONE ? pathParam : null);
        String tok = params.getOrDefault("apiKey", params.get("token"));
        long ms = 30_000L;
        if (params.containsKey("timeoutMs")) {
            try { ms = Long.parseLong(params.get("timeoutMs")); } catch (NumberFormatException ignored) {}
        }
        return new VectorStoreProvider(
                kind,
                endpoint,
                col,
                ns,
                params.getOrDefault("tenant", "default_tenant"),
                params.getOrDefault("database", "default_database"),
                params.get("dbName"),
                tok,
                Duration.ofMillis(Math.max(ms, 100L)),
                transport);
    }

    public Kind getKind() { return kind; }
    public String getEndpoint() { return endpoint; }

    private Map<String, String> headers() {
        Map<String, String> h = new HashMap<>();
        if (token != null && !token.isEmpty()) {
            if (kind == Kind.QDRANT || kind == Kind.PINECONE) {
                h.put("api-key", token);
            } else {
                h.put("Authorization", "Bearer " + token);
            }
        }
        return h;
    }

    private String call(String method, String path, String body) throws IOException, InterruptedException {
        return transport.request(method, endpoint + path, headers(), body, timeout);
    }

    public boolean health() {
        try {
            switch (kind) {
                case NBASE:
                    call("GET", "/health", null);
                    break;
                case QDRANT:
                    call("GET", "/healthz", null);
                    break;
                case CHROMA:
                    call("GET", "/api/v2/heartbeat", null);
                    break;
                case PINECONE:
                    call("POST", "/describe_index_stats", "{}");
                    break;
                case WEAVIATE:
                    call("GET", "/v1/.well-known/ready", null);
                    break;
                case MILVUS:
                    call("POST", "/v2/vectordb/collections/list", dbName != null ? "{\"dbName\":" + quote(dbName) + "}" : "{}");
                    break;
                default:
                    return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public int upsert(List<VectorRecord> vectors) throws IOException, InterruptedException {
        if (vectors == null || vectors.isEmpty()) return 0;
        switch (kind) {
            case NBASE: {
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < vectors.size(); i++) {
                    if (i > 0) sb.append(',');
                    VectorRecord r = vectors.get(i);
                    sb.append("{\"id\":").append(quote(r.id)).append(",\"vector\":").append(vecJson(r.vector)).append('}');
                }
                sb.append(']');
                call("POST", "/api/vectors", sb.toString());
                break;
            }
            case QDRANT: {
                StringBuilder sb = new StringBuilder("{\"points\":[");
                for (int i = 0; i < vectors.size(); i++) {
                    if (i > 0) sb.append(',');
                    VectorRecord r = vectors.get(i);
                    sb.append("{\"id\":").append(quote(r.id)).append(",\"vector\":").append(vecJson(r.vector)).append('}');
                }
                sb.append("]}");
                call("PUT", "/collections/" + enc(collection) + "/points?wait=true", sb.toString());
                break;
            }
            case CHROMA: {
                String cid = resolveChromaId(collection);
                StringBuilder ids = new StringBuilder("[");
                StringBuilder embs = new StringBuilder("[");
                for (int i = 0; i < vectors.size(); i++) {
                    if (i > 0) { ids.append(','); embs.append(','); }
                    ids.append(quote(vectors.get(i).id));
                    embs.append(vecJson(vectors.get(i).vector));
                }
                ids.append(']');
                embs.append(']');
                call("POST", chromaBase() + "/" + enc(cid) + "/upsert", "{\"ids\":" + ids + ",\"embeddings\":" + embs + "}");
                break;
            }
            case PINECONE: {
                StringBuilder sb = new StringBuilder("{\"vectors\":[");
                for (int i = 0; i < vectors.size(); i++) {
                    if (i > 0) sb.append(',');
                    VectorRecord r = vectors.get(i);
                    sb.append("{\"id\":").append(quote(r.id)).append(",\"values\":").append(vecJson(r.vector)).append('}');
                }
                sb.append(']');
                if (namespace != null && !namespace.isEmpty()) sb.append(",\"namespace\":").append(quote(namespace));
                sb.append('}');
                call("POST", "/vectors/upsert", sb.toString());
                break;
            }
            case WEAVIATE: {
                StringBuilder sb = new StringBuilder("{\"objects\":[");
                for (int i = 0; i < vectors.size(); i++) {
                    if (i > 0) sb.append(',');
                    VectorRecord r = vectors.get(i);
                    sb.append("{\"class\":").append(quote(collection)).append(",\"id\":").append(quote(r.id)).append(",\"vector\":").append(vecJson(r.vector)).append('}');
                }
                sb.append("]}");
                call("POST", "/v1/batch/objects", sb.toString());
                break;
            }
            case MILVUS: {
                StringBuilder sb = new StringBuilder("{\"collectionName\":").append(quote(collection)).append(",\"data\":[");
                for (int i = 0; i < vectors.size(); i++) {
                    if (i > 0) sb.append(',');
                    VectorRecord r = vectors.get(i);
                    sb.append("{\"id\":").append(quote(r.id)).append(",\"vector\":").append(vecJson(r.vector)).append('}');
                }
                sb.append(']');
                if (dbName != null) sb.append(",\"dbName\":").append(quote(dbName));
                sb.append('}');
                call("POST", "/v2/vectordb/entities/upsert", sb.toString());
                break;
            }
            default:
                break;
        }
        return vectors.size();
    }

    public String searchRaw(List<Double> vector, int k) throws IOException, InterruptedException {
        String vec = vecJson(vector);
        switch (kind) {
            case NBASE:
                return call("POST", "/api/search", "{\"vector\":" + vec + ",\"k\":" + k + ",\"includeMetadata\":true}");
            case QDRANT:
                return call("POST", "/collections/" + enc(collection) + "/points/search", "{\"vector\":" + vec + ",\"limit\":" + k + ",\"with_payload\":true}");
            case CHROMA:
                return call("POST", chromaBase() + "/" + enc(resolveChromaId(collection)) + "/query", "{\"query_embeddings\":[" + vec + "],\"n_results\":" + k + "}");
            case PINECONE:
                return call("POST", "/query", "{\"vector\":" + vec + ",\"topK\":" + k + ",\"includeMetadata\":true" + (namespace != null ? ",\"namespace\":" + quote(namespace) : "") + "}");
            case WEAVIATE:
                return call("POST", "/v1/graphql", "{\"query\":" + quote("{ Get { " + collection + "(nearVector: { vector: " + vec + " }, limit: " + k + ") { _additional { id distance } } } }") + "}");
            case MILVUS:
                return call("POST", "/v2/vectordb/entities/search", "{\"collectionName\":" + quote(collection) + ",\"data\":[" + vec + "],\"limit\":" + k + ",\"outputFields\":[\"*\"]}");
            default:
                throw new IllegalStateException("Unhandled vector database kind: " + kind);
        }
    }

    private String chromaBase() {
        return "/api/v2/tenants/" + enc(tenant) + "/databases/" + enc(database) + "/collections";
    }

    private String resolveChromaId(String name) throws IOException, InterruptedException {
        if (chromaIds.containsKey(name)) return chromaIds.get(name);
        try {
            String res = call("GET", chromaBase() + "/" + enc(name), null);
            Matcher m = Pattern.compile("\"id\"\\s*:\\s*\"([^\"]+)\"").matcher(res);
            if (m.find()) {
                chromaIds.put(name, m.group(1));
                return m.group(1);
            }
        } catch (IOException ignored) {}
        String created = call("POST", chromaBase(), "{\"name\":" + quote(name) + ",\"get_or_create\":true}");
        Matcher m = Pattern.compile("\"id\"\\s*:\\s*\"([^\"]+)\"").matcher(created);
        String cid = m.find() ? m.group(1) : name;
        chromaIds.put(name, cid);
        return cid;
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new RuntimeException(e);
        }
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static String vecJson(List<Double> v) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < v.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(v.get(i));
        }
        sb.append(']');
        return sb.toString();
    }
}
