using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace An5Adapters.Vector
{
    public enum VectorProviderKind
    {
        NBase,
        Qdrant,
        Chroma,
        Pinecone,
        Weaviate,
        Milvus
    }

    public sealed class VectorRecord
    {
        public string Id { get; set; } = string.Empty;
        public List<double> Vector { get; set; } = new();
        public Dictionary<string, object?>? Metadata { get; set; }
    }

    public sealed class VectorSearchHit
    {
        public string Id { get; set; } = string.Empty;
        public double Distance { get; set; }
        public Dictionary<string, object?>? Metadata { get; set; }
    }

    public interface IVectorStoreProvider
    {
        VectorProviderKind Provider { get; }
        string Endpoint { get; }
        Task<bool> HealthAsync(CancellationToken ct = default);
        Task<int> UpsertAsync(IEnumerable<VectorRecord> vectors, string? collection = null, CancellationToken ct = default);
        Task<List<VectorSearchHit>> SearchAsync(IEnumerable<double> vector, int k = 10, string distanceMetric = "cosine", string? collection = null, CancellationToken ct = default);
        Task<int> DeleteAsync(IEnumerable<string> ids, string? collection = null, CancellationToken ct = default);
    }

    public sealed class HttpVectorStoreClient : IVectorStoreProvider
    {
        private static readonly HttpClient SharedHttp = new() { Timeout = TimeSpan.FromSeconds(30) };

        public VectorProviderKind Provider { get; }
        public string Endpoint { get; }
        public string Collection { get; }
        public string? Namespace { get; }
        public string Tenant { get; }
        public string Database { get; }
        public string? DbName { get; }
        private readonly string? _token;
        private readonly HttpClient _http;
        private readonly Dictionary<string, string> _chromaIds = new();

        public HttpVectorStoreClient(
            VectorProviderKind provider,
            string endpoint,
            string collection = "an5",
            string? ns = null,
            string tenant = "default_tenant",
            string database = "default_database",
            string? dbName = null,
            string? token = null,
            HttpClient? httpClient = null)
        {
            Provider = provider;
            Endpoint = endpoint.TrimEnd('/');
            Collection = collection;
            Namespace = ns;
            Tenant = tenant;
            Database = database;
            DbName = dbName;
            _token = token;
            _http = httpClient ?? SharedHttp;
        }

        public static VectorProviderKind? DetectProvider(string? connStr)
        {
            if (string.IsNullOrWhiteSpace(connStr)) return null;
            var lower = connStr.Trim().ToLowerInvariant();
            if (lower.StartsWith("nbase:")) return VectorProviderKind.NBase;
            if (lower.StartsWith("qdrant:")) return VectorProviderKind.Qdrant;
            if (lower.StartsWith("chroma:")) return VectorProviderKind.Chroma;
            if (lower.StartsWith("pinecone:")) return VectorProviderKind.Pinecone;
            if (lower.StartsWith("weaviate:")) return VectorProviderKind.Weaviate;
            if (lower.StartsWith("milvus:")) return VectorProviderKind.Milvus;
            return null;
        }

        public static bool IsVectorConnectionString(string? connStr) => DetectProvider(connStr) != null;

        public static HttpVectorStoreClient FromConnectionString(string connStr, HttpClient? httpClient = null)
        {
            var kind = DetectProvider(connStr) ?? throw new ArgumentException($"Unsupported vector connection string: {connStr}");
            var raw = connStr.Trim();
            var idx = raw.IndexOf(':');
            var rest = raw[(idx + 1)..];
            if (rest.StartsWith("//")) rest = rest[2..];

            var qIdx = rest.IndexOf('?');
            var pathPart = qIdx >= 0 ? rest[..qIdx] : rest;
            var queryPart = qIdx >= 0 ? rest[(qIdx + 1)..] : string.Empty;
            var query = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in queryPart.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = pair.IndexOf('=');
                if (eq > 0) query[Uri.UnescapeDataString(pair[..eq])] = Uri.UnescapeDataString(pair[(eq + 1)..]);
            }

            var host = pathPart.Trim().TrimEnd('/');
            string? pathParam = null;
            if (!string.IsNullOrEmpty(host) && !host.Contains("://"))
            {
                var slash = host.IndexOf('/');
                if (slash >= 0)
                {
                    pathParam = host[(slash + 1)..];
                    host = host[..slash];
                }
            }

            var scheme = kind == VectorProviderKind.Pinecone ? "https" : "http";
            var fallback = kind switch
            {
                VectorProviderKind.NBase => "localhost:1307",
                VectorProviderKind.Qdrant => "localhost:6333",
                VectorProviderKind.Chroma => "localhost:8000",
                VectorProviderKind.Pinecone => "localhost",
                VectorProviderKind.Weaviate => "localhost:8080",
                VectorProviderKind.Milvus => "localhost:19530",
                _ => "localhost"
            };
            var url = string.IsNullOrEmpty(host) ? $"{scheme}://{fallback}" : (host.Contains("://") ? host : $"{scheme}://{host}");
            var col = query.GetValueOrDefault("collection") ?? query.GetValueOrDefault("className") ?? pathParam ?? (kind == VectorProviderKind.Weaviate ? "An5Vector" : "an5");
            var ns = query.GetValueOrDefault("namespace") ?? (kind == VectorProviderKind.Pinecone ? pathParam : null);
            var token = query.GetValueOrDefault("apiKey") ?? query.GetValueOrDefault("token");

            return new HttpVectorStoreClient(
                kind,
                url,
                col,
                ns,
                query.GetValueOrDefault("tenant") ?? "default_tenant",
                query.GetValueOrDefault("database") ?? "default_database",
                query.GetValueOrDefault("dbName"),
                token,
                httpClient);
        }

        private async Task<JsonDocument> SendJsonAsync(HttpMethod method, string path, object? payload, CancellationToken ct)
        {
            using var req = new HttpRequestMessage(method, Endpoint + path);
            if (!string.IsNullOrEmpty(_token))
            {
                if (Provider is VectorProviderKind.Qdrant or VectorProviderKind.Pinecone)
                    req.Headers.TryAddWithoutValidation("api-key", _token);
                else
                    req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_token}");
            }
            if (payload != null)
            {
                req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            }
            using var resp = await _http.SendAsync(req, ct);
            var text = await resp.Content.ReadAsStringAsync(ct);
            resp.EnsureSuccessStatusCode();
            return string.IsNullOrWhiteSpace(text) ? JsonDocument.Parse("{}") : JsonDocument.Parse(text);
        }

        public async Task<bool> HealthAsync(CancellationToken ct = default)
        {
            try
            {
                switch (Provider)
                {
                    case VectorProviderKind.NBase: await SendJsonAsync(HttpMethod.Get, "/health", null, ct); break;
                    case VectorProviderKind.Qdrant: await SendJsonAsync(HttpMethod.Get, "/healthz", null, ct); break;
                    case VectorProviderKind.Chroma: await SendJsonAsync(HttpMethod.Get, "/api/v2/heartbeat", null, ct); break;
                    case VectorProviderKind.Pinecone: await SendJsonAsync(HttpMethod.Post, "/describe_index_stats", new { }, ct); break;
                    case VectorProviderKind.Weaviate: await SendJsonAsync(HttpMethod.Get, "/v1/.well-known/ready", null, ct); break;
                    case VectorProviderKind.Milvus: await SendJsonAsync(HttpMethod.Post, "/v2/vectordb/collections/list", new { }, ct); break;
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        public async Task<int> UpsertAsync(IEnumerable<VectorRecord> vectors, string? collection = null, CancellationToken ct = default)
        {
            var list = vectors.ToList();
            if (list.Count == 0) return 0;
            var col = collection ?? Collection;
            switch (Provider)
            {
                case VectorProviderKind.NBase:
                    await SendJsonAsync(HttpMethod.Post, "/api/vectors", list.Select(v => new { id = v.Id, vector = v.Vector, metadata = v.Metadata }), ct);
                    break;
                case VectorProviderKind.Qdrant:
                    await SendJsonAsync(HttpMethod.Put, $"/collections/{Uri.EscapeDataString(col)}/points?wait=true", new { points = list.Select(v => new { id = v.Id, vector = v.Vector, payload = v.Metadata }) }, ct);
                    break;
                case VectorProviderKind.Chroma:
                    var cid = await ResolveChromaIdAsync(col, ct);
                    await SendJsonAsync(HttpMethod.Post, $"{ChromaBase()}/{Uri.EscapeDataString(cid)}/upsert", new { ids = list.Select(v => v.Id), embeddings = list.Select(v => v.Vector), metadatas = list.Select(v => v.Metadata ?? new()) }, ct);
                    break;
                case VectorProviderKind.Pinecone:
                    await SendJsonAsync(HttpMethod.Post, "/vectors/upsert", new { vectors = list.Select(v => new { id = v.Id, values = v.Vector, metadata = v.Metadata }), @namespace = Namespace }, ct);
                    break;
                case VectorProviderKind.Weaviate:
                    await SendJsonAsync(HttpMethod.Post, "/v1/batch/objects", new { objects = list.Select(v => new { @class = col, id = v.Id, vector = v.Vector, properties = v.Metadata ?? new() }) }, ct);
                    break;
                case VectorProviderKind.Milvus:
                    await SendJsonAsync(HttpMethod.Post, "/v2/vectordb/entities/upsert", new { collectionName = col, dbName = DbName, data = list.Select(v => new { id = v.Id, vector = v.Vector }) }, ct);
                    break;
            }
            return list.Count;
        }

        public async Task<List<VectorSearchHit>> SearchAsync(IEnumerable<double> vector, int k = 10, string distanceMetric = "cosine", string? collection = null, CancellationToken ct = default)
        {
            var vec = vector.ToList();
            var col = collection ?? Collection;
            var hits = new List<VectorSearchHit>();
            switch (Provider)
            {
                case VectorProviderKind.Qdrant:
                    using (var doc = await SendJsonAsync(HttpMethod.Post, $"/collections/{Uri.EscapeDataString(col)}/points/search", new { vector = vec, limit = k, with_payload = true }, ct))
                    {
                        if (doc.RootElement.TryGetProperty("result", out var arr))
                        {
                            foreach (var el in arr.EnumerateArray())
                            {
                                var score = el.TryGetProperty("score", out var s) ? s.GetDouble() : 0.0;
                                hits.Add(new VectorSearchHit { Id = el.GetProperty("id").ToString(), Distance = distanceMetric == "euclidean" ? score : (distanceMetric == "dot" ? -score : 1.0 - score) });
                            }
                        }
                    }
                    break;
                case VectorProviderKind.Pinecone:
                    using (var doc = await SendJsonAsync(HttpMethod.Post, "/query", new { vector = vec, topK = k, includeMetadata = true, @namespace = Namespace }, ct))
                    {
                        if (doc.RootElement.TryGetProperty("matches", out var arr))
                        {
                            foreach (var el in arr.EnumerateArray())
                            {
                                var score = el.TryGetProperty("score", out var s) ? s.GetDouble() : 0.0;
                                hits.Add(new VectorSearchHit { Id = el.GetProperty("id").ToString(), Distance = distanceMetric == "euclidean" ? score : (distanceMetric == "dot" ? -score : 1.0 - score) });
                            }
                        }
                    }
                    break;
                default:
                    using (var doc = await SendJsonAsync(HttpMethod.Post, "/api/search", new { vector = vec, k, includeMetadata = true }, ct))
                    {
                        if (doc.RootElement.TryGetProperty("results", out var arr))
                        {
                            foreach (var el in arr.EnumerateArray())
                            {
                                hits.Add(new VectorSearchHit { Id = el.GetProperty("id").ToString(), Distance = el.TryGetProperty("dist", out var d) ? d.GetDouble() : 0.0 });
                            }
                        }
                    }
                    break;
            }
            return hits;
        }

        public async Task<int> DeleteAsync(IEnumerable<string> ids, string? collection = null, CancellationToken ct = default)
        {
            var list = ids.ToList();
            if (list.Count == 0) return 0;
            var col = collection ?? Collection;
            switch (Provider)
            {
                case VectorProviderKind.Qdrant:
                    await SendJsonAsync(HttpMethod.Post, $"/collections/{Uri.EscapeDataString(col)}/points/delete?wait=true", new { points = list }, ct);
                    break;
                case VectorProviderKind.Pinecone:
                    await SendJsonAsync(HttpMethod.Post, "/vectors/delete", new { ids = list, @namespace = Namespace }, ct);
                    break;
                default:
                    foreach (var id in list)
                    {
                        await SendJsonAsync(HttpMethod.Delete, $"/api/vectors/{Uri.EscapeDataString(id)}", null, ct);
                    }
                    break;
            }
            return list.Count;
        }

        private string ChromaBase() => $"/api/v2/tenants/{Uri.EscapeDataString(Tenant)}/databases/{Uri.EscapeDataString(Database)}/collections";

        private async Task<string> ResolveChromaIdAsync(string name, CancellationToken ct)
        {
            if (_chromaIds.TryGetValue(name, out var cached)) return cached;
            try
            {
                using var doc = await SendJsonAsync(HttpMethod.Get, $"{ChromaBase()}/{Uri.EscapeDataString(name)}", null, ct);
                if (doc.RootElement.TryGetProperty("id", out var idEl))
                {
                    var id = idEl.GetString() ?? name;
                    _chromaIds[name] = id;
                    return id;
                }
            }
            catch { }
            using var created = await SendJsonAsync(HttpMethod.Post, ChromaBase(), new { name, get_or_create = true }, ct);
            var cid = created.RootElement.TryGetProperty("id", out var cidEl) ? (cidEl.GetString() ?? name) : name;
            _chromaIds[name] = cid;
            return cid;
        }
    }
}
