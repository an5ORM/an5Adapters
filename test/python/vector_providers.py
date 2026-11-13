import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "python"))

from an5_adapter import An5Adapter
from base import set_adapter_metadata
from base.vector_providers import (
    ChromaVectorClient,
    MilvusVectorClient,
    NBaseVectorClient,
    PineconeVectorClient,
    QdrantVectorClient,
    VectorProviderError,
    WeaviateVectorClient,
    create_vector_store,
    detect_vector_provider,
    is_vector_connection_string,
)


def make_requester(routes):
    calls = []

    def requester(method, url, headers, body, timeout_s):
        path = "/" + url.split("://", 1)[1].split("/", 1)[1] if "://" in url else url
        key = f"{method} {path}"
        calls.append({"key": key, "headers": headers, "body": body})
        if key not in routes:
            raise VectorProviderError("test", f"no route for {key}", status=404)
        return routes[key]

    return requester, calls


class TestPythonVectorProviders(unittest.TestCase):
    def test_detect_and_factory(self):
        for scheme, expected in [
            ("nbase://localhost:1307", "nbase"),
            ("qdrant://localhost:6333/docs?apiKey=qk", "qdrant"),
            ("chroma://localhost:8000/docs?tenant=t1&database=d1", "chroma"),
            ("pinecone://idx.pinecone.io/ns1?apiKey=pk", "pinecone"),
            ("weaviate://localhost:8080/Article?apiKey=wk", "weaviate"),
            ("milvus://localhost:19530/docs?dbName=mydb", "milvus"),
        ]:
            self.assertEqual(detect_vector_provider(scheme), expected)
            self.assertTrue(is_vector_connection_string(scheme))
            store = create_vector_store(scheme)
            self.assertEqual(store.provider, expected)

        self.assertIsNone(detect_vector_provider("postgres://localhost:5432/db"))
        self.assertFalse(is_vector_connection_string("sqlite:///:memory:"))

    def test_qdrant_client(self):
        req, calls = make_requester({
            "GET /healthz": {"status": "ok"},
            "PUT /collections/docs/points?wait=true": {"status": "ok"},
            "POST /collections/docs/points/search": {
                "result": [{"id": "Doc:1", "score": 0.9, "payload": {"an5Id": "1", "an5Model": "Doc"}}]
            },
            "POST /collections/docs/points/delete?wait=true": {"status": "ok"},
        })
        c = QdrantVectorClient("http://localhost:6333", collection="docs", api_key="qk", requester=req)
        self.assertTrue(c.health()["ok"])
        self.assertEqual(c.upsert([{"id": "Doc:1", "vector": [1.0, 0.0], "metadata": {"an5Id": "1"}}])["count"], 1)
        self.assertEqual(calls[1]["headers"]["api-key"], "qk")
        hits = c.search([1.0, 0.0], k=5)
        self.assertEqual(len(hits), 1)
        self.assertAlmostEqual(hits[0]["distance"], 0.1)
        self.assertEqual(c.delete(["Doc:1"])["deleted"], 1)

    def test_chroma_client(self):
        req, _ = make_requester({
            "GET /api/v2/heartbeat": {"nanosecond heartbeat": 1},
            "GET /api/v2/tenants/default_tenant/databases/default_database/collections/docs": {"id": "cid-1"},
            "POST /api/v2/tenants/default_tenant/databases/default_database/collections/cid-1/upsert": {},
            "POST /api/v2/tenants/default_tenant/databases/default_database/collections/cid-1/query": {
                "ids": [["Doc:1"]],
                "distances": [[0.2]],
                "metadatas": [[{"an5Id": "1"}]],
            },
            "POST /api/v2/tenants/default_tenant/databases/default_database/collections/cid-1/delete": {},
        })
        c = ChromaVectorClient("http://localhost:8000", collection="docs", requester=req)
        self.assertTrue(c.health()["ok"])
        self.assertEqual(c.upsert([{"id": "Doc:1", "vector": [1.0, 0.0]}])["count"], 1)
        hits = c.search([1.0, 0.0])
        self.assertEqual(hits[0]["distance"], 0.2)
        self.assertEqual(c.delete(["Doc:1"])["deleted"], 1)

    def test_pinecone_weaviate_milvus_nbase(self):
        req_p, _ = make_requester({
            "POST /describe_index_stats": {"totalVectorCount": 1},
            "POST /vectors/upsert": {"upsertedCount": 1},
            "POST /query": {"matches": [{"id": "Doc:1", "score": 0.8, "metadata": {"an5Id": "1"}}]},
            "POST /vectors/delete": {},
        })
        p = PineconeVectorClient("https://idx.pinecone.io", namespace="ns", api_key="pk", requester=req_p)
        self.assertTrue(p.health()["ok"])
        self.assertEqual(p.upsert([{"id": "Doc:1", "vector": [1.0, 0.0]}])["count"], 1)
        self.assertAlmostEqual(p.search([1.0, 0.0])[0]["distance"], 0.2)
        self.assertEqual(p.delete(["Doc:1"])["deleted"], 1)

        req_w, _ = make_requester({
            "GET /v1/.well-known/ready": {},
            "POST /v1/batch/objects": [],
            "POST /v1/graphql": {"data": {"Get": {"Article": [{"an5Id": "1", "_additional": {"id": "u1", "distance": 0.05}}]}}},
            "DELETE /v1/objects/Article/u1": {},
        })
        w = WeaviateVectorClient("http://localhost:8080", class_name="Article", requester=req_w)
        self.assertTrue(w.health()["ok"])
        self.assertEqual(w.upsert([{"id": "u1", "vector": [1.0, 0.0]}])["count"], 1)
        self.assertEqual(w.search([1.0, 0.0])[0]["distance"], 0.05)
        self.assertEqual(w.delete(["u1"])["deleted"], 1)

        req_m, _ = make_requester({
            "POST /v2/vectordb/collections/list": {"code": 0, "data": ["docs"]},
            "POST /v2/vectordb/entities/upsert": {"code": 0, "data": {"upsertCount": 1}},
            "POST /v2/vectordb/entities/search": {"code": 0, "data": [{"id": "Doc:1", "distance": 0.11, "an5Id": "1"}]},
            "POST /v2/vectordb/entities/delete": {"code": 0},
        })
        m = MilvusVectorClient("http://localhost:19530", collection="docs", requester=req_m)
        self.assertTrue(m.health()["ok"])
        self.assertEqual(m.upsert([{"id": "Doc:1", "vector": [1.0, 0.0]}])["count"], 1)
        self.assertEqual(m.search([1.0, 0.0])[0]["distance"], 0.11)
        self.assertEqual(m.delete(["Doc:1"])["deleted"], 1)

        req_n, _ = make_requester({
            "GET /health": {"status": "ok"},
            "POST /api/vectors": {"count": 1},
            "POST /api/search": {"results": [{"id": "Doc:1", "dist": 0.12}]},
            "DELETE /api/vectors/Doc%3A1": {"deleted": True},
        })
        n = NBaseVectorClient("http://localhost:1307", requester=req_n)
        self.assertTrue(n.health()["ok"])
        self.assertEqual(n.upsert([{"id": "Doc:1", "vector": [1.0, 0.0]}])["count"], 1)
        self.assertEqual(n.search([1.0, 0.0])[0]["distance"], 0.12)
        self.assertEqual(n.delete(["Doc:1"])["deleted"], 1)

    def test_adapter_sidecar_and_vector_only(self):
        vec_only = An5Adapter("qdrant://localhost:6333/docs")
        self.assertTrue(vec_only.vector_store_only)
        self.assertEqual(vec_only.vector_store().provider, "qdrant")

        set_adapter_metadata({
            "modelToTable": {"Doc": "docs"},
            "modelFields": {
                "Doc": [
                    {"name": "id", "sql": "TEXT", "isId": True},
                    {"name": "title", "sql": "TEXT"},
                    {"name": "embedding", "sql": "VECTOR(2)"},
                ]
            },
        })
        req, _ = make_requester({
            "GET /healthz": {"status": "ok"},
            "PUT /collections/docs/points?wait=true": {"status": "ok"},
            "POST /collections/docs/points/search": {
                "result": [
                    {"id": "Doc:d2", "score": 0.95, "payload": {"an5Id": "d2", "an5Model": "Doc"}},
                    {"id": "Doc:d1", "score": 0.70, "payload": {"an5Id": "d1", "an5Model": "Doc"}},
                ]
            },
        })
        store = QdrantVectorClient("http://localhost:6333", collection="docs", requester=req)
        db = An5Adapter("sqlite:///:memory:", vector_store=store)
        db.execute_raw("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, embedding BLOB)")
        doc = db.table("Doc")
        doc.create({"id": "d1", "title": "First", "embedding": [1.0, 0.0]})
        doc.create({"id": "d2", "title": "Second", "embedding": [0.0, 1.0]})

        self.assertTrue(db.vector_health()["ok"])
        self.assertEqual(doc.index_vectors(vector_field="embedding")["indexed"], 2)
        res = doc.vector_search([0.0, 1.0], take=2)
        self.assertEqual([r["id"] for r in res], ["d2", "d1"])
        self.assertAlmostEqual(res[0]["distance"], 0.05)
        db.close()


if __name__ == "__main__":
    unittest.main()
