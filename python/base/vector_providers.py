"""Unified vector database providers for AN5 ORM (Python).

Zero-dependency REST clients using Python's standard library ``urllib.request``
for NBase, Qdrant, Chroma, Pinecone, Weaviate, and Milvus.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Union


class VectorProviderError(Exception):
    def __init__(
        self,
        provider: str,
        message: str,
        status: Optional[int] = None,
        body: Any = None,
    ):
        super().__init__(message)
        self.provider = provider
        self.status = status
        self.body = body


_PREFIXES = {
    "nbase": re.compile(r"^nbase:(?://)?", re.IGNORECASE),
    "qdrant": re.compile(r"^qdrant:(?://)?", re.IGNORECASE),
    "chroma": re.compile(r"^chroma:(?://)?", re.IGNORECASE),
    "pinecone": re.compile(r"^pinecone:(?://)?", re.IGNORECASE),
    "weaviate": re.compile(r"^weaviate:(?://)?", re.IGNORECASE),
    "milvus": re.compile(r"^milvus:(?://)?", re.IGNORECASE),
}


def detect_vector_provider(connection_string: str) -> Optional[str]:
    raw = (connection_string or "").strip()
    for name, pattern in _PREFIXES.items():
        if pattern.match(raw):
            return name
    return None


def is_vector_connection_string(connection_string: str) -> bool:
    return detect_vector_provider(connection_string) is not None


def _normalize_url(raw_url: str, default_scheme: str = "http", fallback_host: str = "localhost") -> str:
    trimmed = raw_url.strip().rstrip("/")
    if not trimmed:
        return f"{default_scheme}://{fallback_host}"
    if re.match(r"^[a-z]+://", trimmed, re.IGNORECASE):
        return trimmed
    return f"{default_scheme}://{trimmed}"


def _parse_generic_conn(
    provider: str,
    connection_string: str,
    default_scheme: str,
    fallback_host: str,
    path_key: str = "collection",
) -> Dict[str, Any]:
    raw = connection_string.strip()
    pattern = _PREFIXES[provider]
    if not pattern.match(raw):
        raise ValueError(f"Not a {provider} connection string: {raw}")

    stripped = pattern.sub("", raw, count=1)
    if "?" in stripped:
        without_prefix, query = stripped.split("?", 1)
    else:
        without_prefix, query = stripped, ""

    params = urllib.parse.parse_qs(query, keep_blank_values=False)

    def get_param(key: str) -> Optional[str]:
        vals = params.get(key)
        return vals[0] if vals else None

    raw_url = without_prefix.strip().rstrip("/")
    path_val = get_param(path_key)
    if raw_url and not re.match(r"^[a-z]+://", raw_url, re.IGNORECASE) and "/" in raw_url:
        host_part, tail = raw_url.split("/", 1)
        if tail and not path_val:
            path_val = tail
        raw_url = host_part

    cfg: Dict[str, Any] = {
        "url": _normalize_url(raw_url, default_scheme, fallback_host),
    }
    if path_val:
        cfg[path_key] = path_val
    for k in ("apiKey", "token", "tenant", "database", "collectionId", "dbName", "idField", "modelField", "method", "collection", "namespace", "className"):
        v = get_param(k)
        if v is not None and k not in cfg:
            cfg[k] = v
    timeout = get_param("timeoutMs")
    if timeout is not None:
        cfg["timeout_ms"] = int(timeout)
    return cfg


def _similarity_to_distance(score: float, metric: str = "cosine") -> float:
    if metric == "euclidean":
        return float(score)
    if metric == "dot":
        return -float(score)
    return 1.0 - float(score)


class VectorStoreProvider:
    provider: str = ""
    endpoint: str = ""
    id_field: str = "an5Id"
    model_field: str = "an5Model"

    def __init__(
        self,
        url: str,
        token: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout_ms: int = 30_000,
        id_field: str = "an5Id",
        model_field: str = "an5Model",
        requester: Optional[Callable[[str, str, Dict[str, str], Optional[Any], float], Any]] = None,
    ):
        self.endpoint = url.rstrip("/")
        self.token = token or api_key
        self.timeout_s = max(timeout_ms / 1000.0, 0.1)
        self.id_field = id_field
        self.model_field = model_field
        self._requester = requester

    def _default_headers(self) -> Dict[str, str]:
        return {}

    def _request(self, method: str, path: str, body: Optional[Any] = None) -> Any:
        headers = {"Content-Type": "application/json", **self._default_headers()}
        if self._requester is not None:
            return self._requester(method, f"{self.endpoint}{path}", headers, body, self.timeout_s)

        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"{self.endpoint}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else {}
            except Exception:
                parsed = raw
            raise VectorProviderError(
                self.provider,
                f"{self.provider} request {path} failed: HTTP {err.code}",
                status=err.code,
                body=parsed,
            ) from err
        except Exception as err:
            raise VectorProviderError(
                self.provider,
                f"Could not reach {self.provider} at {self.endpoint}: {err}",
            ) from err

    def health(self) -> Dict[str, Any]:
        raise NotImplementedError

    def upsert(
        self,
        vectors: List[Dict[str, Any]],
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> Dict[str, int]:
        raise NotImplementedError

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def delete(
        self,
        ids: List[Union[str, int]],
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> Dict[str, int]:
        raise NotImplementedError


class NBaseVectorClient(VectorStoreProvider):
    provider = "nbase"

    def __init__(self, url: str = "http://localhost:1307", method: Optional[str] = None, **kwargs: Any):
        super().__init__(_normalize_url(url, "http", "localhost:1307"), **kwargs)
        self.method = method

    def _default_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def health(self) -> Dict[str, Any]:
        try:
            res = self._request("GET", "/health")
            return {"ok": res.get("status") == "ok", "provider": self.provider, "endpoint": self.endpoint, **res}
        except Exception as err:
            return {"ok": False, "provider": self.provider, "endpoint": self.endpoint, "error": str(err)}

    def upsert(self, vectors: List[Dict[str, Any]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not vectors:
            return {"count": 0}
        res = self._request("POST", "/api/vectors", vectors)
        return {"count": int(res.get("count", len(vectors)))}

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        payload: Dict[str, Any] = {
            "vector": vector,
            "k": k,
            "distanceMetric": "euclidean" if distance_metric == "euclidean" else "cosine",
            "includeMetadata": include_metadata,
            "includeVectors": include_vectors,
        }
        if self.method:
            payload["method"] = self.method
        if filter is not None:
            payload["filters"] = filter
        res = self._request("POST", "/api/search", payload)
        return [
            {
                "id": h["id"],
                "distance": float(h.get("dist", 0.0)),
                **({"metadata": h["metadata"]} if "metadata" in h and h["metadata"] is not None else {}),
                **({"vector": h["vector"]} if "vector" in h and h["vector"] is not None else {}),
            }
            for h in res.get("results", [])
        ]

    def delete(self, ids: List[Union[str, int]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        deleted = 0
        for vid in ids:
            self._request("DELETE", f"/api/vectors/{urllib.parse.quote(str(vid), safe='')}")
            deleted += 1
        return {"deleted": deleted}


class QdrantVectorClient(VectorStoreProvider):
    provider = "qdrant"

    def __init__(self, url: str = "http://localhost:6333", collection: str = "an5", **kwargs: Any):
        super().__init__(_normalize_url(url, "http", "localhost:6333"), **kwargs)
        self.collection = collection

    def _default_headers(self) -> Dict[str, str]:
        return {"api-key": self.token} if self.token else {}

    def health(self) -> Dict[str, Any]:
        try:
            res = self._request("GET", "/healthz")
            return {"ok": True, "provider": self.provider, "endpoint": self.endpoint, **res}
        except Exception as err:
            return {"ok": False, "provider": self.provider, "endpoint": self.endpoint, "error": str(err)}

    def upsert(self, vectors: List[Dict[str, Any]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not vectors:
            return {"count": 0}
        col = urllib.parse.quote(collection or self.collection, safe="")
        points = [
            {
                "id": v["id"],
                "vector": v["vector"],
                **({"payload": v["metadata"]} if v.get("metadata") is not None else {}),
            }
            for v in vectors
        ]
        self._request("PUT", f"/collections/{col}/points?wait=true", {"points": points})
        return {"count": len(vectors)}

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        col = urllib.parse.quote(collection or self.collection, safe="")
        payload: Dict[str, Any] = {
            "vector": vector,
            "limit": k,
            "with_payload": include_metadata,
            "with_vector": include_vectors,
        }
        if filter is not None:
            payload["filter"] = filter
        res = self._request("POST", f"/collections/{col}/points/search", payload)
        return [
            {
                "id": item["id"],
                "distance": _similarity_to_distance(item.get("score", 0.0), distance_metric),
                **({"metadata": item["payload"]} if item.get("payload") is not None else {}),
                **({"vector": item["vector"]} if item.get("vector") is not None else {}),
            }
            for item in res.get("result", [])
        ]

    def delete(self, ids: List[Union[str, int]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not ids:
            return {"deleted": 0}
        col = urllib.parse.quote(collection or self.collection, safe="")
        self._request("POST", f"/collections/{col}/points/delete?wait=true", {"points": ids})
        return {"deleted": len(ids)}


class ChromaVectorClient(VectorStoreProvider):
    provider = "chroma"

    def __init__(
        self,
        url: str = "http://localhost:8000",
        collection: str = "an5",
        tenant: str = "default_tenant",
        database: str = "default_database",
        collection_id: Optional[str] = None,
        **kwargs: Any,
    ):
        super().__init__(_normalize_url(url, "http", "localhost:8000"), **kwargs)
        self.collection = collection
        self.tenant = tenant
        self.database = database
        self._collection_ids: Dict[str, str] = {}
        if collection_id:
            self._collection_ids[collection] = collection_id

    def _default_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _base_path(self) -> str:
        t = urllib.parse.quote(self.tenant, safe="")
        d = urllib.parse.quote(self.database, safe="")
        return f"/api/v2/tenants/{t}/databases/{d}/collections"

    def _resolve_collection_id(self, name: str) -> str:
        if name in self._collection_ids:
            return self._collection_ids[name]
        try:
            col = self._request("GET", f"{self._base_path()}/{urllib.parse.quote(name, safe='')}")
            if isinstance(col, dict) and col.get("id"):
                self._collection_ids[name] = str(col["id"])
                return self._collection_ids[name]
        except Exception:
            pass
        created = self._request("POST", self._base_path(), {"name": name, "get_or_create": True})
        cid = str(created.get("id", name)) if isinstance(created, dict) else name
        self._collection_ids[name] = cid
        return cid

    def health(self) -> Dict[str, Any]:
        try:
            res = self._request("GET", "/api/v2/heartbeat")
            return {"ok": True, "provider": self.provider, "endpoint": self.endpoint, **(res if isinstance(res, dict) else {})}
        except Exception as err:
            return {"ok": False, "provider": self.provider, "endpoint": self.endpoint, "error": str(err)}

    def upsert(self, vectors: List[Dict[str, Any]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not vectors:
            return {"count": 0}
        cid = urllib.parse.quote(self._resolve_collection_id(collection or self.collection), safe="")
        self._request(
            "POST",
            f"{self._base_path()}/{cid}/upsert",
            {
                "ids": [str(v["id"]) for v in vectors],
                "embeddings": [v["vector"] for v in vectors],
                "metadatas": [v.get("metadata") or {} for v in vectors],
            },
        )
        return {"count": len(vectors)}

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        cid = urllib.parse.quote(self._resolve_collection_id(collection or self.collection), safe="")
        include = ["distances"]
        if include_metadata:
            include.append("metadatas")
        if include_vectors:
            include.append("embeddings")
        payload: Dict[str, Any] = {"query_embeddings": [vector], "n_results": k, "include": include}
        if filter is not None:
            payload["where"] = filter
        res = self._request("POST", f"{self._base_path()}/{cid}/query", payload)
        ids = (res.get("ids") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        vecs = (res.get("embeddings") or [[]])[0]
        hits: List[Dict[str, Any]] = []
        for idx, vid in enumerate(ids):
            hit: Dict[str, Any] = {"id": vid, "distance": float(dists[idx]) if idx < len(dists) else 0.0}
            if idx < len(metas) and metas[idx] is not None:
                hit["metadata"] = metas[idx]
            if idx < len(vecs) and vecs[idx] is not None:
                hit["vector"] = vecs[idx]
            hits.append(hit)
        return hits

    def delete(self, ids: List[Union[str, int]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not ids:
            return {"deleted": 0}
        cid = urllib.parse.quote(self._resolve_collection_id(collection or self.collection), safe="")
        self._request("POST", f"{self._base_path()}/{cid}/delete", {"ids": [str(i) for i in ids]})
        return {"deleted": len(ids)}


class PineconeVectorClient(VectorStoreProvider):
    provider = "pinecone"

    def __init__(self, url: str = "https://localhost", namespace: Optional[str] = None, **kwargs: Any):
        super().__init__(_normalize_url(url, "https", "localhost"), **kwargs)
        self.namespace = namespace

    def _default_headers(self) -> Dict[str, str]:
        return {"api-key": self.token} if self.token else {}

    def health(self) -> Dict[str, Any]:
        try:
            res = self._request("POST", "/describe_index_stats", {})
            return {"ok": True, "provider": self.provider, "endpoint": self.endpoint, **(res if isinstance(res, dict) else {})}
        except Exception as err:
            return {"ok": False, "provider": self.provider, "endpoint": self.endpoint, "error": str(err)}

    def upsert(self, vectors: List[Dict[str, Any]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not vectors:
            return {"count": 0}
        ns = namespace or self.namespace
        payload: Dict[str, Any] = {
            "vectors": [
                {
                    "id": str(v["id"]),
                    "values": v["vector"],
                    **({"metadata": v["metadata"]} if v.get("metadata") is not None else {}),
                }
                for v in vectors
            ]
        }
        if ns:
            payload["namespace"] = ns
        res = self._request("POST", "/vectors/upsert", payload)
        return {"count": int(res.get("upsertedCount", len(vectors))) if isinstance(res, dict) else len(vectors)}

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        ns = namespace or self.namespace
        payload: Dict[str, Any] = {
            "vector": vector,
            "topK": k,
            "includeMetadata": include_metadata,
            "includeValues": include_vectors,
        }
        if ns:
            payload["namespace"] = ns
        if filter is not None:
            payload["filter"] = filter
        res = self._request("POST", "/query", payload)
        return [
            {
                "id": m["id"],
                "distance": _similarity_to_distance(m.get("score", 0.0), distance_metric),
                **({"metadata": m["metadata"]} if m.get("metadata") is not None else {}),
                **({"vector": m["values"]} if m.get("values") is not None else {}),
            }
            for m in res.get("matches", [])
        ]

    def delete(self, ids: List[Union[str, int]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not ids:
            return {"deleted": 0}
        ns = namespace or self.namespace
        payload: Dict[str, Any] = {"ids": [str(i) for i in ids]}
        if ns:
            payload["namespace"] = ns
        self._request("POST", "/vectors/delete", payload)
        return {"deleted": len(ids)}


class WeaviateVectorClient(VectorStoreProvider):
    provider = "weaviate"

    def __init__(self, url: str = "http://localhost:8080", class_name: str = "An5Vector", **kwargs: Any):
        super().__init__(_normalize_url(url, "http", "localhost:8080"), **kwargs)
        self.class_name = class_name

    def _default_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def health(self) -> Dict[str, Any]:
        try:
            self._request("GET", "/v1/.well-known/ready")
            return {"ok": True, "provider": self.provider, "endpoint": self.endpoint, "status": "ok"}
        except Exception as err:
            return {"ok": False, "provider": self.provider, "endpoint": self.endpoint, "error": str(err)}

    def upsert(self, vectors: List[Dict[str, Any]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not vectors:
            return {"count": 0}
        cls = collection or self.class_name
        objects = [
            {
                "class": cls,
                "id": str(v["id"]),
                "vector": v["vector"],
                "properties": v.get("metadata") or {},
            }
            for v in vectors
        ]
        self._request("POST", "/v1/batch/objects", {"objects": objects})
        return {"count": len(vectors)}

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        cls = collection or self.class_name
        extra = ["id", "distance"] + (["vector"] if include_vectors else [])
        props = f"{self.id_field} {self.model_field} " if include_metadata else ""
        gql = f"{{ Get {{ {cls}(nearVector: {{ vector: {json.dumps(vector)} }}, limit: {k}) {{ {props}_additional {{ {' '.join(extra)} }} }} }} }}"
        res = self._request("POST", "/v1/graphql", {"query": gql})
        if res.get("errors"):
            raise VectorProviderError(self.provider, f"weaviate graphql error: {res['errors']}")
        items = (res.get("data") or {}).get("Get", {}).get(cls, [])
        hits: List[Dict[str, Any]] = []
        for item in items:
            add = item.get("_additional") or {}
            meta = {k2: v2 for k2, v2 in item.items() if k2 != "_additional"}
            hit: Dict[str, Any] = {"id": str(add.get("id", "")), "distance": float(add.get("distance", 0.0))}
            if meta:
                hit["metadata"] = meta
            if isinstance(add.get("vector"), list):
                hit["vector"] = add["vector"]
            hits.append(hit)
        return hits

    def delete(self, ids: List[Union[str, int]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not ids:
            return {"deleted": 0}
        cls = urllib.parse.quote(collection or self.class_name, safe="")
        for vid in ids:
            self._request("DELETE", f"/v1/objects/{cls}/{urllib.parse.quote(str(vid), safe='')}")
        return {"deleted": len(ids)}


class MilvusVectorClient(VectorStoreProvider):
    provider = "milvus"

    def __init__(self, url: str = "http://localhost:19530", collection: str = "an5", db_name: Optional[str] = None, **kwargs: Any):
        super().__init__(_normalize_url(url, "http", "localhost:19530"), **kwargs)
        self.collection = collection
        self.db_name = db_name

    def _default_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _check_code(self, res: Any, path: str) -> None:
        if isinstance(res, dict) and res.get("code") not in (None, 0, 200):
            raise VectorProviderError(self.provider, f"milvus {path} failed: {res.get('message', res.get('code'))}")

    def health(self) -> Dict[str, Any]:
        try:
            body: Dict[str, Any] = {"dbName": self.db_name} if self.db_name else {}
            res = self._request("POST", "/v2/vectordb/collections/list", body)
            self._check_code(res, "/v2/vectordb/collections/list")
            return {"ok": True, "provider": self.provider, "endpoint": self.endpoint, "status": "ok"}
        except Exception as err:
            return {"ok": False, "provider": self.provider, "endpoint": self.endpoint, "error": str(err)}

    def upsert(self, vectors: List[Dict[str, Any]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not vectors:
            return {"count": 0}
        data = [{"id": v["id"], "vector": v["vector"], **(v.get("metadata") or {})} for v in vectors]
        body: Dict[str, Any] = {"collectionName": collection or self.collection, "data": data}
        if self.db_name:
            body["dbName"] = self.db_name
        res = self._request("POST", "/v2/vectordb/entities/upsert", body)
        self._check_code(res, "/v2/vectordb/entities/upsert")
        count = (res.get("data") or {}).get("upsertCount", len(vectors)) if isinstance(res, dict) else len(vectors)
        return {"count": int(count)}

    def search(
        self,
        vector: List[float],
        k: int = 10,
        distance_metric: str = "cosine",
        filter: Optional[Dict[str, Any]] = None,
        include_metadata: bool = True,
        include_vectors: bool = False,
        collection: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        body: Dict[str, Any] = {
            "collectionName": collection or self.collection,
            "data": [vector],
            "limit": k,
            "outputFields": ["*"] if include_metadata else ["id"],
        }
        if self.db_name:
            body["dbName"] = self.db_name
        if filter and isinstance(filter.get("expr"), str):
            body["filter"] = filter["expr"]
        res = self._request("POST", "/v2/vectordb/entities/search", body)
        self._check_code(res, "/v2/vectordb/entities/search")
        hits: List[Dict[str, Any]] = []
        for item in res.get("data", []):
            meta = {k2: v2 for k2, v2 in item.items() if k2 not in ("id", "distance", "vector")}
            hit: Dict[str, Any] = {"id": item.get("id", ""), "distance": float(item.get("distance", 0.0))}
            if meta:
                hit["metadata"] = meta
            if isinstance(item.get("vector"), list):
                hit["vector"] = item["vector"]
            hits.append(hit)
        return hits

    def delete(self, ids: List[Union[str, int]], collection: Optional[str] = None, namespace: Optional[str] = None) -> Dict[str, int]:
        if not ids:
            return {"deleted": 0}
        quoted = [str(i) if isinstance(i, int) else f'"{str(i).replace(chr(34), chr(92) + chr(34))}"' for i in ids]
        body: Dict[str, Any] = {
            "collectionName": collection or self.collection,
            "filter": f"id in [{', '.join(quoted)}]",
        }
        if self.db_name:
            body["dbName"] = self.db_name
        res = self._request("POST", "/v2/vectordb/entities/delete", body)
        self._check_code(res, "/v2/vectordb/entities/delete")
        return {"deleted": len(ids)}


def create_vector_store(
    conn_or_provider: Union[str, VectorStoreProvider],
    requester: Optional[Callable[[str, str, Dict[str, str], Optional[Any], float], Any]] = None,
) -> VectorStoreProvider:
    if isinstance(conn_or_provider, VectorStoreProvider):
        return conn_or_provider

    provider = detect_vector_provider(conn_or_provider)
    if provider == "nbase":
        cfg = _parse_generic_conn("nbase", conn_or_provider, "http", "localhost:1307")
        return NBaseVectorClient(
            url=cfg["url"],
            token=cfg.get("token"),
            method=cfg.get("method"),
            timeout_ms=cfg.get("timeout_ms", 30_000),
            id_field=cfg.get("idField", "an5Id"),
            model_field=cfg.get("modelField", "an5Model"),
            requester=requester,
        )
    if provider == "qdrant":
        cfg = _parse_generic_conn("qdrant", conn_or_provider, "http", "localhost:6333", "collection")
        return QdrantVectorClient(
            url=cfg["url"],
            collection=cfg.get("collection", "an5"),
            api_key=cfg.get("apiKey") or cfg.get("token"),
            timeout_ms=cfg.get("timeout_ms", 30_000),
            id_field=cfg.get("idField", "an5Id"),
            model_field=cfg.get("modelField", "an5Model"),
            requester=requester,
        )
    if provider == "chroma":
        cfg = _parse_generic_conn("chroma", conn_or_provider, "http", "localhost:8000", "collection")
        return ChromaVectorClient(
            url=cfg["url"],
            collection=cfg.get("collection", "an5"),
            tenant=cfg.get("tenant", "default_tenant"),
            database=cfg.get("database", "default_database"),
            collection_id=cfg.get("collectionId"),
            token=cfg.get("token") or cfg.get("apiKey"),
            timeout_ms=cfg.get("timeout_ms", 30_000),
            id_field=cfg.get("idField", "an5Id"),
            model_field=cfg.get("modelField", "an5Model"),
            requester=requester,
        )
    if provider == "pinecone":
        cfg = _parse_generic_conn("pinecone", conn_or_provider, "https", "localhost", "namespace")
        return PineconeVectorClient(
            url=cfg["url"],
            namespace=cfg.get("namespace"),
            api_key=cfg.get("apiKey") or cfg.get("token"),
            timeout_ms=cfg.get("timeout_ms", 30_000),
            id_field=cfg.get("idField", "an5Id"),
            model_field=cfg.get("modelField", "an5Model"),
            requester=requester,
        )
    if provider == "weaviate":
        cfg = _parse_generic_conn("weaviate", conn_or_provider, "http", "localhost:8080", "className")
        return WeaviateVectorClient(
            url=cfg["url"],
            class_name=cfg.get("className") or cfg.get("collection") or "An5Vector",
            api_key=cfg.get("apiKey") or cfg.get("token"),
            timeout_ms=cfg.get("timeout_ms", 30_000),
            id_field=cfg.get("idField", "an5Id"),
            model_field=cfg.get("modelField", "an5Model"),
            requester=requester,
        )
    if provider == "milvus":
        cfg = _parse_generic_conn("milvus", conn_or_provider, "http", "localhost:19530", "collection")
        return MilvusVectorClient(
            url=cfg["url"],
            collection=cfg.get("collection", "an5"),
            db_name=cfg.get("dbName"),
            token=cfg.get("token") or cfg.get("apiKey"),
            timeout_ms=cfg.get("timeout_ms", 30_000),
            id_field=cfg.get("idField", "an5Id"),
            model_field=cfg.get("modelField", "an5Model"),
            requester=requester,
        )
    raise ValueError(f"Unsupported vector database connection string: {conn_or_provider}")
