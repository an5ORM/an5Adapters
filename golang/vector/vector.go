// Package vector provides unified REST clients for external vector databases
// (NBase, Qdrant, Chroma, Pinecone, Weaviate, and Milvus) using Go's standard library.
package vector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// VectorProviderError is returned when a vector database HTTP call fails.
type VectorProviderError struct {
	Provider string
	Status   int
	Message  string
}

func (e *VectorProviderError) Error() string {
	return fmt.Sprintf("%s: %s", e.Provider, e.Message)
}

// VectorRecord represents a vector point to upsert.
type VectorRecord struct {
	ID       string                 `json:"id"`
	Vector   []float64              `json:"vector"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// SearchOptions configures a vector similarity search.
type SearchOptions struct {
	K               int
	DistanceMetric  string
	Filter          map[string]interface{}
	IncludeMetadata *bool
	IncludeVectors  bool
	Collection      string
	Namespace       string
}

// VectorSearchHit represents a single search result from a vector store.
type VectorSearchHit struct {
	ID       string                 `json:"id"`
	Distance float64                `json:"distance"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
	Vector   []float64              `json:"vector,omitempty"`
}

// UpsertOptions configures an Upsert call.
type UpsertOptions struct {
	Collection string
	Namespace  string
}

// DeleteOptions configures a Delete call.
type DeleteOptions struct {
	Collection string
	Namespace  string
}

// VectorStoreProvider is the unified interface implemented by all vector DB clients.
type VectorStoreProvider interface {
	Provider() string
	Endpoint() string
	IDField() string
	ModelField() string
	Health(ctx context.Context) (map[string]interface{}, error)
	Upsert(ctx context.Context, vectors []VectorRecord, opts *UpsertOptions) (int, error)
	Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error)
	Delete(ctx context.Context, ids []string, opts *DeleteOptions) (int, error)
}

// HTTPDoer abstracts *http.Client for offline testing.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// DetectVectorProvider returns the vector provider name for a connection string, or "".
func DetectVectorProvider(connStr string) string {
	lower := strings.ToLower(strings.TrimSpace(connStr))
	for _, p := range []string{"nbase", "qdrant", "chroma", "pinecone", "weaviate", "milvus"} {
		if strings.HasPrefix(lower, p+":") {
			return p
		}
	}
	return ""
}

// IsVectorConnectionString reports whether connStr targets an external vector database.
func IsVectorConnectionString(connStr string) bool {
	return DetectVectorProvider(connStr) != ""
}

type parsedConn struct {
	URL          string
	PathParam    string
	APIKey       string
	Token        string
	Tenant       string
	Database     string
	CollectionID string
	DBName       string
	IDField      string
	ModelField   string
	Method       string
	Timeout      time.Duration
	Query        url.Values
}

func parseVectorConn(provider, connStr, defaultScheme, fallbackHost string) (*parsedConn, error) {
	raw := strings.TrimSpace(connStr)
	lower := strings.ToLower(raw)
	prefix := provider + ":"
	if !strings.HasPrefix(lower, prefix) {
		return nil, fmt.Errorf("not a %s connection string: %s", provider, raw)
	}
	rest := raw[len(prefix):]
	if strings.HasPrefix(rest, "//") {
		rest = rest[2:]
	}
	pathPart := rest
	queryPart := ""
	if idx := strings.IndexByte(rest, '?'); idx != -1 {
		pathPart = rest[:idx]
		queryPart = rest[idx+1:]
	}
	q, _ := url.ParseQuery(queryPart)
	trimmed := strings.TrimRight(strings.TrimSpace(pathPart), "/")
	var tail string
	if trimmed != "" && !strings.Contains(trimmed, "://") {
		if slash := strings.IndexByte(trimmed, '/'); slash != -1 {
			tail = trimmed[slash+1:]
			trimmed = trimmed[:slash]
		}
	}
	var baseURL string
	if trimmed == "" {
		baseURL = defaultScheme + "://" + fallbackHost
	} else if strings.Contains(trimmed, "://") {
		baseURL = trimmed
	} else {
		baseURL = defaultScheme + "://" + trimmed
	}
	timeout := 30 * time.Second
	if msStr := q.Get("timeoutMs"); msStr != "" {
		if ms, err := strconv.Atoi(msStr); err == nil && ms > 0 {
			timeout = time.Duration(ms) * time.Millisecond
		}
	}
	idField := q.Get("idField")
	if idField == "" {
		idField = "an5Id"
	}
	modelField := q.Get("modelField")
	if modelField == "" {
		modelField = "an5Model"
	}
	return &parsedConn{
		URL:          baseURL,
		PathParam:    tail,
		APIKey:       q.Get("apiKey"),
		Token:        q.Get("token"),
		Tenant:       q.Get("tenant"),
		Database:     q.Get("database"),
		CollectionID: q.Get("collectionId"),
		DBName:       q.Get("dbName"),
		IDField:      idField,
		ModelField:   modelField,
		Method:       q.Get("method"),
		Timeout:      timeout,
		Query:        q,
	}, nil
}

func doJSON(ctx context.Context, doer HTTPDoer, timeout time.Duration, provider, baseURL, method, path string, headers map[string]string, body interface{}, out interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(b)
	}
	if doer == nil {
		doer = &http.Client{Timeout: timeout}
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(baseURL, "/")+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := doer.Do(req)
	if err != nil {
		return &VectorProviderError{Provider: provider, Message: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return &VectorProviderError{
			Provider: provider,
			Status:   resp.StatusCode,
			Message:  fmt.Sprintf("HTTP %d on %s: %s", resp.StatusCode, path, string(raw)),
		}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return err
		}
	}
	return nil
}

func similarityToDistance(score float64, metric string) float64 {
	switch metric {
	case "euclidean":
		return score
	case "dot":
		return -score
	default:
		return 1.0 - score
	}
}

type baseConfig struct {
	provider   string
	endpoint   string
	token      string
	idField    string
	modelField string
	timeout    time.Duration
	httpClient HTTPDoer
}

func (b *baseConfig) Provider() string   { return b.provider }
func (b *baseConfig) Endpoint() string   { return b.endpoint }
func (b *baseConfig) IDField() string    { return b.idField }
func (b *baseConfig) ModelField() string { return b.modelField }

// ─── NBase ───────────────────────────────────────────────────────────────────

type NBaseClient struct {
	baseConfig
	Method string
}

func NewNBaseClient(endpoint, token string, httpClient HTTPDoer) *NBaseClient {
	return &NBaseClient{
		baseConfig: baseConfig{provider: "nbase", endpoint: strings.TrimRight(endpoint, "/"), token: token, idField: "an5Id", modelField: "an5Model", timeout: 30 * time.Second, httpClient: httpClient},
	}
}

func (c *NBaseClient) headers() map[string]string {
	if c.token != "" {
		return map[string]string{"Authorization": "Bearer " + c.token}
	}
	return nil
}

func (c *NBaseClient) Health(ctx context.Context) (map[string]interface{}, error) {
	var res map[string]interface{}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "GET", "/health", c.headers(), nil, &res); err != nil {
		return map[string]interface{}{"ok": false, "provider": c.provider, "error": err.Error()}, err
	}
	if res == nil {
		res = map[string]interface{}{}
	}
	res["ok"] = res["status"] == "ok"
	res["provider"] = c.provider
	return res, nil
}

func (c *NBaseClient) Upsert(ctx context.Context, vectors []VectorRecord, _ *UpsertOptions) (int, error) {
	if len(vectors) == 0 {
		return 0, nil
	}
	var res struct {
		Count int `json:"count"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/api/vectors", c.headers(), vectors, &res); err != nil {
		return 0, err
	}
	if res.Count == 0 {
		return len(vectors), nil
	}
	return res.Count, nil
}

func (c *NBaseClient) Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error) {
	k := 10
	metric := "cosine"
	includeMeta := true
	if opts != nil {
		if opts.K > 0 {
			k = opts.K
		}
		if opts.DistanceMetric == "euclidean" {
			metric = "euclidean"
		}
		if opts.IncludeMetadata != nil {
			includeMeta = *opts.IncludeMetadata
		}
	}
	body := map[string]interface{}{
		"vector":          vector,
		"k":               k,
		"distanceMetric":  metric,
		"includeMetadata": includeMeta,
	}
	if c.Method != "" {
		body["method"] = c.Method
	}
	var res struct {
		Results []struct {
			ID       interface{}            `json:"id"`
			Dist     float64                `json:"dist"`
			Metadata map[string]interface{} `json:"metadata"`
			Vector   []float64              `json:"vector"`
		} `json:"results"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/api/search", c.headers(), body, &res); err != nil {
		return nil, err
	}
	hits := make([]VectorSearchHit, 0, len(res.Results))
	for _, r := range res.Results {
		hits = append(hits, VectorSearchHit{
			ID:       fmt.Sprint(r.ID),
			Distance: r.Dist,
			Metadata: r.Metadata,
			Vector:   r.Vector,
		})
	}
	return hits, nil
}

func (c *NBaseClient) Delete(ctx context.Context, ids []string, _ *DeleteOptions) (int, error) {
	deleted := 0
	for _, id := range ids {
		if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "DELETE", "/api/vectors/"+url.PathEscape(id), c.headers(), nil, nil); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}

// ─── Qdrant ──────────────────────────────────────────────────────────────────

type QdrantClient struct {
	baseConfig
	Collection string
}

func NewQdrantClient(endpoint, collection, apiKey string, httpClient HTTPDoer) *QdrantClient {
	if collection == "" {
		collection = "an5"
	}
	return &QdrantClient{
		baseConfig: baseConfig{provider: "qdrant", endpoint: strings.TrimRight(endpoint, "/"), token: apiKey, idField: "an5Id", modelField: "an5Model", timeout: 30 * time.Second, httpClient: httpClient},
		Collection: collection,
	}
}

func (c *QdrantClient) headers() map[string]string {
	if c.token != "" {
		return map[string]string{"api-key": c.token}
	}
	return nil
}

func (c *QdrantClient) Health(ctx context.Context) (map[string]interface{}, error) {
	var res map[string]interface{}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "GET", "/healthz", c.headers(), nil, &res); err != nil {
		return map[string]interface{}{"ok": false, "provider": c.provider, "error": err.Error()}, err
	}
	return map[string]interface{}{"ok": true, "provider": c.provider, "endpoint": c.endpoint}, nil
}

func (c *QdrantClient) Upsert(ctx context.Context, vectors []VectorRecord, opts *UpsertOptions) (int, error) {
	if len(vectors) == 0 {
		return 0, nil
	}
	col := c.Collection
	if opts != nil && opts.Collection != "" {
		col = opts.Collection
	}
	points := make([]map[string]interface{}, 0, len(vectors))
	for _, v := range vectors {
		p := map[string]interface{}{"id": v.ID, "vector": v.Vector}
		if v.Metadata != nil {
			p["payload"] = v.Metadata
		}
		points = append(points, p)
	}
	path := "/collections/" + url.PathEscape(col) + "/points?wait=true"
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "PUT", path, c.headers(), map[string]interface{}{"points": points}, nil); err != nil {
		return 0, err
	}
	return len(vectors), nil
}

func (c *QdrantClient) Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error) {
	col := c.Collection
	k := 10
	metric := "cosine"
	includeMeta := true
	includeVec := false
	if opts != nil {
		if opts.Collection != "" {
			col = opts.Collection
		}
		if opts.K > 0 {
			k = opts.K
		}
		if opts.DistanceMetric != "" {
			metric = opts.DistanceMetric
		}
		if opts.IncludeMetadata != nil {
			includeMeta = *opts.IncludeMetadata
		}
		includeVec = opts.IncludeVectors
	}
	body := map[string]interface{}{
		"vector":       vector,
		"limit":        k,
		"with_payload": includeMeta,
		"with_vector":  includeVec,
	}
	if opts != nil && opts.Filter != nil {
		body["filter"] = opts.Filter
	}
	var res struct {
		Result []struct {
			ID      interface{}            `json:"id"`
			Score   float64                `json:"score"`
			Payload map[string]interface{} `json:"payload"`
			Vector  []float64              `json:"vector"`
		} `json:"result"`
	}
	path := "/collections/" + url.PathEscape(col) + "/points/search"
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", path, c.headers(), body, &res); err != nil {
		return nil, err
	}
	hits := make([]VectorSearchHit, 0, len(res.Result))
	for _, r := range res.Result {
		hits = append(hits, VectorSearchHit{
			ID:       fmt.Sprint(r.ID),
			Distance: similarityToDistance(r.Score, metric),
			Metadata: r.Payload,
			Vector:   r.Vector,
		})
	}
	return hits, nil
}

func (c *QdrantClient) Delete(ctx context.Context, ids []string, opts *DeleteOptions) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	col := c.Collection
	if opts != nil && opts.Collection != "" {
		col = opts.Collection
	}
	path := "/collections/" + url.PathEscape(col) + "/points/delete?wait=true"
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", path, c.headers(), map[string]interface{}{"points": ids}, nil); err != nil {
		return 0, err
	}
	return len(ids), nil
}

// ─── Chroma ──────────────────────────────────────────────────────────────────

type ChromaClient struct {
	baseConfig
	Collection    string
	Tenant        string
	Database      string
	mu            sync.Mutex
	collectionIDs map[string]string
}

func NewChromaClient(endpoint, collection, tenant, database, token string, httpClient HTTPDoer) *ChromaClient {
	if collection == "" {
		collection = "an5"
	}
	if tenant == "" {
		tenant = "default_tenant"
	}
	if database == "" {
		database = "default_database"
	}
	return &ChromaClient{
		baseConfig:    baseConfig{provider: "chroma", endpoint: strings.TrimRight(endpoint, "/"), token: token, idField: "an5Id", modelField: "an5Model", timeout: 30 * time.Second, httpClient: httpClient},
		Collection:    collection,
		Tenant:        tenant,
		Database:      database,
		collectionIDs: map[string]string{},
	}
}

func (c *ChromaClient) headers() map[string]string {
	if c.token != "" {
		return map[string]string{"Authorization": "Bearer " + c.token}
	}
	return nil
}

func (c *ChromaClient) basePath() string {
	return "/api/v2/tenants/" + url.PathEscape(c.Tenant) + "/databases/" + url.PathEscape(c.Database) + "/collections"
}

func (c *ChromaClient) resolveCollectionID(ctx context.Context, name string) (string, error) {
	c.mu.Lock()
	if id, ok := c.collectionIDs[name]; ok {
		c.mu.Unlock()
		return id, nil
	}
	c.mu.Unlock()

	var col struct {
		ID string `json:"id"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "GET", c.basePath()+"/"+url.PathEscape(name), c.headers(), nil, &col); err == nil && col.ID != "" {
		c.mu.Lock()
		c.collectionIDs[name] = col.ID
		c.mu.Unlock()
		return col.ID, nil
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", c.basePath(), c.headers(), map[string]interface{}{"name": name, "get_or_create": true}, &col); err != nil {
		return "", err
	}
	id := col.ID
	if id == "" {
		id = name
	}
	c.mu.Lock()
	c.collectionIDs[name] = id
	c.mu.Unlock()
	return id, nil
}

func (c *ChromaClient) Health(ctx context.Context) (map[string]interface{}, error) {
	var res map[string]interface{}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "GET", "/api/v2/heartbeat", c.headers(), nil, &res); err != nil {
		return map[string]interface{}{"ok": false, "provider": c.provider, "error": err.Error()}, err
	}
	return map[string]interface{}{"ok": true, "provider": c.provider, "endpoint": c.endpoint}, nil
}

func (c *ChromaClient) Upsert(ctx context.Context, vectors []VectorRecord, opts *UpsertOptions) (int, error) {
	if len(vectors) == 0 {
		return 0, nil
	}
	name := c.Collection
	if opts != nil && opts.Collection != "" {
		name = opts.Collection
	}
	cid, err := c.resolveCollectionID(ctx, name)
	if err != nil {
		return 0, err
	}
	ids := make([]string, len(vectors))
	embs := make([][]float64, len(vectors))
	metas := make([]map[string]interface{}, len(vectors))
	for i, v := range vectors {
		ids[i] = v.ID
		embs[i] = v.Vector
		if v.Metadata != nil {
			metas[i] = v.Metadata
		} else {
			metas[i] = map[string]interface{}{}
		}
	}
	body := map[string]interface{}{"ids": ids, "embeddings": embs, "metadatas": metas}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", c.basePath()+"/"+url.PathEscape(cid)+"/upsert", c.headers(), body, nil); err != nil {
		return 0, err
	}
	return len(vectors), nil
}

func (c *ChromaClient) Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error) {
	name := c.Collection
	k := 10
	if opts != nil {
		if opts.Collection != "" {
			name = opts.Collection
		}
		if opts.K > 0 {
			k = opts.K
		}
	}
	cid, err := c.resolveCollectionID(ctx, name)
	if err != nil {
		return nil, err
	}
	include := []string{"distances", "metadatas"}
	body := map[string]interface{}{"query_embeddings": [][]float64{vector}, "n_results": k, "include": include}
	var res struct {
		IDs       [][]string                 `json:"ids"`
		Distances [][]float64                `json:"distances"`
		Metadatas [][]map[string]interface{} `json:"metadatas"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", c.basePath()+"/"+url.PathEscape(cid)+"/query", c.headers(), body, &res); err != nil {
		return nil, err
	}
	if len(res.IDs) == 0 {
		return nil, nil
	}
	hits := make([]VectorSearchHit, 0, len(res.IDs[0]))
	for i, id := range res.IDs[0] {
		var dist float64
		if len(res.Distances) > 0 && i < len(res.Distances[0]) {
			dist = res.Distances[0][i]
		}
		var meta map[string]interface{}
		if len(res.Metadatas) > 0 && i < len(res.Metadatas[0]) {
			meta = res.Metadatas[0][i]
		}
		hits = append(hits, VectorSearchHit{ID: id, Distance: dist, Metadata: meta})
	}
	return hits, nil
}

func (c *ChromaClient) Delete(ctx context.Context, ids []string, opts *DeleteOptions) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	name := c.Collection
	if opts != nil && opts.Collection != "" {
		name = opts.Collection
	}
	cid, err := c.resolveCollectionID(ctx, name)
	if err != nil {
		return 0, err
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", c.basePath()+"/"+url.PathEscape(cid)+"/delete", c.headers(), map[string]interface{}{"ids": ids}, nil); err != nil {
		return 0, err
	}
	return len(ids), nil
}

// ─── Pinecone ────────────────────────────────────────────────────────────────

type PineconeClient struct {
	baseConfig
	Namespace string
}

func NewPineconeClient(endpoint, namespace, apiKey string, httpClient HTTPDoer) *PineconeClient {
	return &PineconeClient{
		baseConfig: baseConfig{provider: "pinecone", endpoint: strings.TrimRight(endpoint, "/"), token: apiKey, idField: "an5Id", modelField: "an5Model", timeout: 30 * time.Second, httpClient: httpClient},
		Namespace:  namespace,
	}
}

func (c *PineconeClient) headers() map[string]string {
	if c.token != "" {
		return map[string]string{"api-key": c.token}
	}
	return nil
}

func (c *PineconeClient) Health(ctx context.Context) (map[string]interface{}, error) {
	var res map[string]interface{}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/describe_index_stats", c.headers(), map[string]interface{}{}, &res); err != nil {
		return map[string]interface{}{"ok": false, "provider": c.provider, "error": err.Error()}, err
	}
	return map[string]interface{}{"ok": true, "provider": c.provider, "endpoint": c.endpoint}, nil
}

func (c *PineconeClient) Upsert(ctx context.Context, vectors []VectorRecord, opts *UpsertOptions) (int, error) {
	if len(vectors) == 0 {
		return 0, nil
	}
	ns := c.Namespace
	if opts != nil && opts.Namespace != "" {
		ns = opts.Namespace
	}
	vecs := make([]map[string]interface{}, len(vectors))
	for i, v := range vectors {
		item := map[string]interface{}{"id": v.ID, "values": v.Vector}
		if v.Metadata != nil {
			item["metadata"] = v.Metadata
		}
		vecs[i] = item
	}
	body := map[string]interface{}{"vectors": vecs}
	if ns != "" {
		body["namespace"] = ns
	}
	var res struct {
		UpsertedCount int `json:"upsertedCount"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/vectors/upsert", c.headers(), body, &res); err != nil {
		return 0, err
	}
	if res.UpsertedCount == 0 {
		return len(vectors), nil
	}
	return res.UpsertedCount, nil
}

func (c *PineconeClient) Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error) {
	ns := c.Namespace
	k := 10
	metric := "cosine"
	if opts != nil {
		if opts.Namespace != "" {
			ns = opts.Namespace
		}
		if opts.K > 0 {
			k = opts.K
		}
		if opts.DistanceMetric != "" {
			metric = opts.DistanceMetric
		}
	}
	body := map[string]interface{}{"vector": vector, "topK": k, "includeMetadata": true}
	if ns != "" {
		body["namespace"] = ns
	}
	var res struct {
		Matches []struct {
			ID       string                 `json:"id"`
			Score    float64                `json:"score"`
			Metadata map[string]interface{} `json:"metadata"`
		} `json:"matches"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/query", c.headers(), body, &res); err != nil {
		return nil, err
	}
	hits := make([]VectorSearchHit, 0, len(res.Matches))
	for _, m := range res.Matches {
		hits = append(hits, VectorSearchHit{ID: m.ID, Distance: similarityToDistance(m.Score, metric), Metadata: m.Metadata})
	}
	return hits, nil
}

func (c *PineconeClient) Delete(ctx context.Context, ids []string, opts *DeleteOptions) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	ns := c.Namespace
	if opts != nil && opts.Namespace != "" {
		ns = opts.Namespace
	}
	body := map[string]interface{}{"ids": ids}
	if ns != "" {
		body["namespace"] = ns
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/vectors/delete", c.headers(), body, nil); err != nil {
		return 0, err
	}
	return len(ids), nil
}

// ─── Weaviate ────────────────────────────────────────────────────────────────

type WeaviateClient struct {
	baseConfig
	ClassName string
}

func NewWeaviateClient(endpoint, className, apiKey string, httpClient HTTPDoer) *WeaviateClient {
	if className == "" {
		className = "An5Vector"
	}
	return &WeaviateClient{
		baseConfig: baseConfig{provider: "weaviate", endpoint: strings.TrimRight(endpoint, "/"), token: apiKey, idField: "an5Id", modelField: "an5Model", timeout: 30 * time.Second, httpClient: httpClient},
		ClassName:  className,
	}
}

func (c *WeaviateClient) headers() map[string]string {
	if c.token != "" {
		return map[string]string{"Authorization": "Bearer " + c.token}
	}
	return nil
}

func (c *WeaviateClient) Health(ctx context.Context) (map[string]interface{}, error) {
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "GET", "/v1/.well-known/ready", c.headers(), nil, nil); err != nil {
		return map[string]interface{}{"ok": false, "provider": c.provider, "error": err.Error()}, err
	}
	return map[string]interface{}{"ok": true, "provider": c.provider, "endpoint": c.endpoint}, nil
}

func (c *WeaviateClient) Upsert(ctx context.Context, vectors []VectorRecord, opts *UpsertOptions) (int, error) {
	if len(vectors) == 0 {
		return 0, nil
	}
	cls := c.ClassName
	if opts != nil && opts.Collection != "" {
		cls = opts.Collection
	}
	objs := make([]map[string]interface{}, len(vectors))
	for i, v := range vectors {
		props := v.Metadata
		if props == nil {
			props = map[string]interface{}{}
		}
		objs[i] = map[string]interface{}{"class": cls, "id": v.ID, "vector": v.Vector, "properties": props}
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/v1/batch/objects", c.headers(), map[string]interface{}{"objects": objs}, nil); err != nil {
		return 0, err
	}
	return len(vectors), nil
}

func (c *WeaviateClient) Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error) {
	cls := c.ClassName
	k := 10
	if opts != nil {
		if opts.Collection != "" {
			cls = opts.Collection
		}
		if opts.K > 0 {
			k = opts.K
		}
	}
	vecJSON, _ := json.Marshal(vector)
	gql := fmt.Sprintf(`{ Get { %s(nearVector: { vector: %s }, limit: %d) { %s %s _additional { id distance } } } }`, cls, string(vecJSON), k, c.idField, c.modelField)
	var res struct {
		Data struct {
			Get map[string][]map[string]interface{} `json:"Get"`
		} `json:"data"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/v1/graphql", c.headers(), map[string]interface{}{"query": gql}, &res); err != nil {
		return nil, err
	}
	items := res.Data.Get[cls]
	hits := make([]VectorSearchHit, 0, len(items))
	for _, item := range items {
		add, _ := item["_additional"].(map[string]interface{})
		id := fmt.Sprint(add["id"])
		dist, _ := add["distance"].(float64)
		meta := map[string]interface{}{}
		for mk, mv := range item {
			if mk != "_additional" {
				meta[mk] = mv
			}
		}
		hits = append(hits, VectorSearchHit{ID: id, Distance: dist, Metadata: meta})
	}
	return hits, nil
}

func (c *WeaviateClient) Delete(ctx context.Context, ids []string, opts *DeleteOptions) (int, error) {
	cls := c.ClassName
	if opts != nil && opts.Collection != "" {
		cls = opts.Collection
	}
	deleted := 0
	for _, id := range ids {
		if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "DELETE", "/v1/objects/"+url.PathEscape(cls)+"/"+url.PathEscape(id), c.headers(), nil, nil); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}

// ─── Milvus ──────────────────────────────────────────────────────────────────

type MilvusClient struct {
	baseConfig
	Collection string
	DBName     string
}

func NewMilvusClient(endpoint, collection, dbName, token string, httpClient HTTPDoer) *MilvusClient {
	if collection == "" {
		collection = "an5"
	}
	return &MilvusClient{
		baseConfig: baseConfig{provider: "milvus", endpoint: strings.TrimRight(endpoint, "/"), token: token, idField: "an5Id", modelField: "an5Model", timeout: 30 * time.Second, httpClient: httpClient},
		Collection: collection,
		DBName:     dbName,
	}
}

func (c *MilvusClient) headers() map[string]string {
	if c.token != "" {
		return map[string]string{"Authorization": "Bearer " + c.token}
	}
	return nil
}

func (c *MilvusClient) Health(ctx context.Context) (map[string]interface{}, error) {
	body := map[string]interface{}{}
	if c.DBName != "" {
		body["dbName"] = c.DBName
	}
	var res map[string]interface{}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/v2/vectordb/collections/list", c.headers(), body, &res); err != nil {
		return map[string]interface{}{"ok": false, "provider": c.provider, "error": err.Error()}, err
	}
	return map[string]interface{}{"ok": true, "provider": c.provider, "endpoint": c.endpoint}, nil
}

func (c *MilvusClient) Upsert(ctx context.Context, vectors []VectorRecord, opts *UpsertOptions) (int, error) {
	if len(vectors) == 0 {
		return 0, nil
	}
	col := c.Collection
	if opts != nil && opts.Collection != "" {
		col = opts.Collection
	}
	data := make([]map[string]interface{}, len(vectors))
	for i, v := range vectors {
		row := map[string]interface{}{"id": v.ID, "vector": v.Vector}
		for mk, mv := range v.Metadata {
			row[mk] = mv
		}
		data[i] = row
	}
	body := map[string]interface{}{"collectionName": col, "data": data}
	if c.DBName != "" {
		body["dbName"] = c.DBName
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/v2/vectordb/entities/upsert", c.headers(), body, nil); err != nil {
		return 0, err
	}
	return len(vectors), nil
}

func (c *MilvusClient) Search(ctx context.Context, vector []float64, opts *SearchOptions) ([]VectorSearchHit, error) {
	col := c.Collection
	k := 10
	if opts != nil {
		if opts.Collection != "" {
			col = opts.Collection
		}
		if opts.K > 0 {
			k = opts.K
		}
	}
	body := map[string]interface{}{"collectionName": col, "data": [][]float64{vector}, "limit": k, "outputFields": []string{"*"}}
	if c.DBName != "" {
		body["dbName"] = c.DBName
	}
	var res struct {
		Data []map[string]interface{} `json:"data"`
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/v2/vectordb/entities/search", c.headers(), body, &res); err != nil {
		return nil, err
	}
	hits := make([]VectorSearchHit, 0, len(res.Data))
	for _, item := range res.Data {
		dist, _ := item["distance"].(float64)
		meta := map[string]interface{}{}
		for mk, mv := range item {
			if mk != "id" && mk != "distance" && mk != "vector" {
				meta[mk] = mv
			}
		}
		hits = append(hits, VectorSearchHit{ID: fmt.Sprint(item["id"]), Distance: dist, Metadata: meta})
	}
	return hits, nil
}

func (c *MilvusClient) Delete(ctx context.Context, ids []string, opts *DeleteOptions) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	col := c.Collection
	if opts != nil && opts.Collection != "" {
		col = opts.Collection
	}
	quoted := make([]string, len(ids))
	for i, id := range ids {
		quoted[i] = strconv.Quote(id)
	}
	body := map[string]interface{}{"collectionName": col, "filter": "id in [" + strings.Join(quoted, ", ") + "]"}
	if c.DBName != "" {
		body["dbName"] = c.DBName
	}
	if err := doJSON(ctx, c.httpClient, c.timeout, c.provider, c.endpoint, "POST", "/v2/vectordb/entities/delete", c.headers(), body, nil); err != nil {
		return 0, err
	}
	return len(ids), nil
}

// CreateVectorStore parses a vector database connection string and constructs the matching provider.
func CreateVectorStore(connStr string) (VectorStoreProvider, error) {
	provider := DetectVectorProvider(connStr)
	switch provider {
	case "nbase":
		cfg, err := parseVectorConn("nbase", connStr, "http", "localhost:1307")
		if err != nil {
			return nil, err
		}
		c := NewNBaseClient(cfg.URL, cfg.Token, nil)
		c.Method = cfg.Method
		c.idField = cfg.IDField
		c.modelField = cfg.ModelField
		c.timeout = cfg.Timeout
		return c, nil
	case "qdrant":
		cfg, err := parseVectorConn("qdrant", connStr, "http", "localhost:6333")
		if err != nil {
			return nil, err
		}
		col := cfg.Query.Get("collection")
		if col == "" {
			col = cfg.PathParam
		}
		key := cfg.APIKey
		if key == "" {
			key = cfg.Token
		}
		c := NewQdrantClient(cfg.URL, col, key, nil)
		c.idField = cfg.IDField
		c.modelField = cfg.ModelField
		c.timeout = cfg.Timeout
		return c, nil
	case "chroma":
		cfg, err := parseVectorConn("chroma", connStr, "http", "localhost:8000")
		if err != nil {
			return nil, err
		}
		col := cfg.Query.Get("collection")
		if col == "" {
			col = cfg.PathParam
		}
		c := NewChromaClient(cfg.URL, col, cfg.Tenant, cfg.Database, cfg.Token, nil)
		if cfg.CollectionID != "" && col != "" {
			c.collectionIDs[col] = cfg.CollectionID
		}
		c.idField = cfg.IDField
		c.modelField = cfg.ModelField
		c.timeout = cfg.Timeout
		return c, nil
	case "pinecone":
		cfg, err := parseVectorConn("pinecone", connStr, "https", "localhost")
		if err != nil {
			return nil, err
		}
		ns := cfg.Query.Get("namespace")
		if ns == "" {
			ns = cfg.PathParam
		}
		key := cfg.APIKey
		if key == "" {
			key = cfg.Token
		}
		c := NewPineconeClient(cfg.URL, ns, key, nil)
		c.idField = cfg.IDField
		c.modelField = cfg.ModelField
		c.timeout = cfg.Timeout
		return c, nil
	case "weaviate":
		cfg, err := parseVectorConn("weaviate", connStr, "http", "localhost:8080")
		if err != nil {
			return nil, err
		}
		cls := cfg.Query.Get("className")
		if cls == "" {
			cls = cfg.PathParam
		}
		key := cfg.APIKey
		if key == "" {
			key = cfg.Token
		}
		c := NewWeaviateClient(cfg.URL, cls, key, nil)
		c.idField = cfg.IDField
		c.modelField = cfg.ModelField
		c.timeout = cfg.Timeout
		return c, nil
	case "milvus":
		cfg, err := parseVectorConn("milvus", connStr, "http", "localhost:19530")
		if err != nil {
			return nil, err
		}
		col := cfg.Query.Get("collection")
		if col == "" {
			col = cfg.PathParam
		}
		c := NewMilvusClient(cfg.URL, col, cfg.DBName, cfg.Token, nil)
		c.idField = cfg.IDField
		c.modelField = cfg.ModelField
		c.timeout = cfg.Timeout
		return c, nil
	default:
		return nil, fmt.Errorf("unsupported vector database connection string: %s", connStr)
	}
}
