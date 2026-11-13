package vector

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"
)

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func stubHTTP(routes map[string]string) HTTPDoer {
	return roundTripFunc(func(req *http.Request) (*http.Response, error) {
		key := req.Method + " " + req.URL.RequestURI()
		body, ok := routes[key]
		if !ok {
			return &http.Response{
				StatusCode: 404,
				Body:       io.NopCloser(bytes.NewBufferString(`{"error":"not found"}`)),
			}, nil
		}
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(bytes.NewBufferString(body)),
		}, nil
	})
}

func TestDetectAndCreateVectorStore(t *testing.T) {
	cases := map[string]string{
		"nbase://localhost:1307":               "nbase",
		"qdrant://localhost:6333/docs":         "qdrant",
		"chroma://localhost:8000/docs":         "chroma",
		"pinecone://idx.pinecone.io/ns1":       "pinecone",
		"weaviate://localhost:8080/Article":    "weaviate",
		"milvus://localhost:19530/docs":        "milvus",
	}
	for conn, want := range cases {
		if got := DetectVectorProvider(conn); got != want {
			t.Fatalf("DetectVectorProvider(%q) = %q, want %q", conn, got, want)
		}
		store, err := CreateVectorStore(conn)
		if err != nil {
			t.Fatalf("CreateVectorStore(%q) error: %v", conn, err)
		}
		if store.Provider() != want {
			t.Fatalf("store.Provider() = %q, want %q", store.Provider(), want)
		}
	}
	if IsVectorConnectionString("postgres://localhost:5432/db") {
		t.Fatal("postgres should not be detected as vector provider")
	}
}

func TestAllGoVectorClients(t *testing.T) {
	ctx := context.Background()

	q := NewQdrantClient("http://localhost:6333", "docs", "qk", stubHTTP(map[string]string{
		"GET /healthz":                        `{"status":"ok"}`,
		"PUT /collections/docs/points?wait=true": `{"status":"ok"}`,
		"POST /collections/docs/points/search":   `{"result":[{"id":"Doc:1","score":0.9,"payload":{"an5Id":"1"}}]}`,
		"POST /collections/docs/points/delete?wait=true": `{"status":"ok"}`,
	}))
	if h, err := q.Health(ctx); err != nil || h["ok"] != true {
		t.Fatalf("qdrant health failed: %v %v", h, err)
	}
	if n, err := q.Upsert(ctx, []VectorRecord{{ID: "Doc:1", Vector: []float64{1, 0}}}, nil); err != nil || n != 1 {
		t.Fatalf("qdrant upsert failed: %d %v", n, err)
	}
	if hits, err := q.Search(ctx, []float64{1, 0}, nil); err != nil || len(hits) != 1 {
		t.Fatalf("qdrant search failed: %v %v", hits, err)
	}
	if d, err := q.Delete(ctx, []string{"Doc:1"}, nil); err != nil || d != 1 {
		t.Fatalf("qdrant delete failed: %d %v", d, err)
	}

	ch := NewChromaClient("http://localhost:8000", "docs", "", "", "", stubHTTP(map[string]string{
		"GET /api/v2/heartbeat":                                                          `{}`,
		"GET /api/v2/tenants/default_tenant/databases/default_database/collections/docs": `{"id":"cid-1"}`,
		"POST /api/v2/tenants/default_tenant/databases/default_database/collections/cid-1/upsert": `{}`,
		"POST /api/v2/tenants/default_tenant/databases/default_database/collections/cid-1/query":  `{"ids":[["Doc:1"]],"distances":[[0.2]],"metadatas":[[{"an5Id":"1"}]]}`,
		"POST /api/v2/tenants/default_tenant/databases/default_database/collections/cid-1/delete": `{}`,
	}))
	if _, err := ch.Upsert(ctx, []VectorRecord{{ID: "Doc:1", Vector: []float64{1, 0}}}, nil); err != nil {
		t.Fatalf("chroma upsert failed: %v", err)
	}
	if hits, err := ch.Search(ctx, []float64{1, 0}, nil); err != nil || len(hits) != 1 || hits[0].Distance != 0.2 {
		t.Fatalf("chroma search failed: %v %v", hits, err)
	}

	pc := NewPineconeClient("https://idx.pinecone.io", "ns1", "pk", stubHTTP(map[string]string{
		"POST /vectors/upsert": `{"upsertedCount":1}`,
		"POST /query":          `{"matches":[{"id":"Doc:1","score":0.85,"metadata":{"an5Id":"1"}}]}`,
	}))
	if n, err := pc.Upsert(ctx, []VectorRecord{{ID: "Doc:1", Vector: []float64{1, 0}}}, nil); err != nil || n != 1 {
		t.Fatalf("pinecone upsert failed: %d %v", n, err)
	}
	if hits, err := pc.Search(ctx, []float64{1, 0}, nil); err != nil || len(hits) != 1 {
		t.Fatalf("pinecone search failed: %v %v", hits, err)
	}

	wv := NewWeaviateClient("http://localhost:8080", "Article", "wk", stubHTTP(map[string]string{
		"POST /v1/batch/objects": `[]`,
		"POST /v1/graphql":       `{"data":{"Get":{"Article":[{"an5Id":"1","_additional":{"id":"u1","distance":0.05}}]}}}`,
	}))
	if n, err := wv.Upsert(ctx, []VectorRecord{{ID: "u1", Vector: []float64{1, 0}}}, nil); err != nil || n != 1 {
		t.Fatalf("weaviate upsert failed: %d %v", n, err)
	}
	if hits, err := wv.Search(ctx, []float64{1, 0}, nil); err != nil || len(hits) != 1 || hits[0].Distance != 0.05 {
		t.Fatalf("weaviate search failed: %v %v", hits, err)
	}

	mv := NewMilvusClient("http://localhost:19530", "docs", "", "", stubHTTP(map[string]string{
		"POST /v2/vectordb/entities/upsert": `{"code":0}`,
		"POST /v2/vectordb/entities/search": `{"code":0,"data":[{"id":"Doc:1","distance":0.11,"an5Id":"1"}]}`,
	}))
	if n, err := mv.Upsert(ctx, []VectorRecord{{ID: "Doc:1", Vector: []float64{1, 0}}}, nil); err != nil || n != 1 {
		t.Fatalf("milvus upsert failed: %d %v", n, err)
	}
	if hits, err := mv.Search(ctx, []float64{1, 0}, nil); err != nil || len(hits) != 1 || hits[0].Distance != 0.11 {
		t.Fatalf("milvus search failed: %v %v", hits, err)
	}
}
