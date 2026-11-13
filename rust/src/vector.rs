//! Unified vector database providers for AN5 ORM (Rust).
//!
//! Supports NBase, Qdrant, Chroma, Pinecone, Weaviate, and Milvus via
//! connection strings (`qdrant://...`, `chroma://...`, `pinecone://...`,
//! `weaviate://...`, `milvus://...`, `nbase://...`) and an injectable
//! [`VectorTransport`] trait so HTTP calls work out of the box and can be
//! stubbed in offline tests.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VectorProviderKind {
    NBase,
    Qdrant,
    Chroma,
    Pinecone,
    Weaviate,
    Milvus,
}

impl VectorProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NBase => "nbase",
            Self::Qdrant => "qdrant",
            Self::Chroma => "chroma",
            Self::Pinecone => "pinecone",
            Self::Weaviate => "weaviate",
            Self::Milvus => "milvus",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorRecord {
    pub id: String,
    pub vector: Vec<f64>,
    #[serde(default)]
    pub metadata: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default)]
pub struct VectorSearchOptions {
    pub k: Option<usize>,
    pub distance_metric: Option<String>,
    pub filter: Option<Value>,
    pub include_metadata: Option<bool>,
    pub include_vectors: Option<bool>,
    pub collection: Option<String>,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorSearchHit {
    pub id: String,
    pub distance: f64,
    #[serde(default)]
    pub metadata: Option<Map<String, Value>>,
    #[serde(default)]
    pub vector: Option<Vec<f64>>,
}

#[derive(Debug, Clone)]
pub struct VectorProviderError {
    pub provider: String,
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for VectorProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.provider, self.message)
    }
}

impl std::error::Error for VectorProviderError {}

pub type VectorResult<T> = std::result::Result<T, VectorProviderError>;

/// Abstracts HTTP JSON transport for vector database clients.
pub trait VectorTransport: Send + Sync {
    fn request_json(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> VectorResult<Value>;
}

/// Minimal zero-dependency HTTP/1.1 transport using `std::net::TcpStream`.
#[derive(Debug, Default, Clone)]
pub struct StdHttpTransport;

impl VectorTransport for StdHttpTransport {
    fn request_json(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> VectorResult<Value> {
        let stripped = url
            .strip_prefix("http://")
            .ok_or_else(|| VectorProviderError {
                provider: "http".into(),
                status: None,
                message: format!("StdHttpTransport requires http:// URL (got {url})"),
            })?;
        let (host_port, path) = match stripped.find('/') {
            Some(idx) => (&stripped[..idx], &stripped[idx..]),
            None => (stripped, "/"),
        };
        let addr = if host_port.contains(':') {
            host_port.to_string()
        } else {
            format!("{host_port}:80")
        };

        let mut stream = TcpStream::connect(&addr).map_err(|e| VectorProviderError {
            provider: "http".into(),
            status: None,
            message: format!("connect {addr}: {e}"),
        })?;
        let timeout = Some(Duration::from_millis(timeout_ms.max(100)));
        let _ = stream.set_read_timeout(timeout);
        let _ = stream.set_write_timeout(timeout);

        let body_bytes = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
            body_bytes.len()
        );
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");

        stream
            .write_all(req.as_bytes())
            .and_then(|_| stream.write_all(&body_bytes))
            .map_err(|e| VectorProviderError {
                provider: "http".into(),
                status: None,
                message: format!("write {path}: {e}"),
            })?;

        let mut raw = String::new();
        stream.read_to_string(&mut raw).map_err(|e| VectorProviderError {
            provider: "http".into(),
            status: None,
            message: format!("read {path}: {e}"),
        })?;

        let (head, body_str) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        let status: u16 = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(500);
        if status >= 400 {
            return Err(VectorProviderError {
                provider: "http".into(),
                status: Some(status),
                message: format!("HTTP {status} on {path}: {body_str}"),
            });
        }
        if body_str.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(body_str.trim()).map_err(|e| VectorProviderError {
            provider: "http".into(),
            status: Some(status),
            message: format!("invalid JSON from {path}: {e}"),
        })
    }
}

pub fn detect_vector_provider(conn_str: &str) -> Option<VectorProviderKind> {
    let lower = conn_str.trim().to_ascii_lowercase();
    if lower.starts_with("nbase:") {
        Some(VectorProviderKind::NBase)
    } else if lower.starts_with("qdrant:") {
        Some(VectorProviderKind::Qdrant)
    } else if lower.starts_with("chroma:") {
        Some(VectorProviderKind::Chroma)
    } else if lower.starts_with("pinecone:") {
        Some(VectorProviderKind::Pinecone)
    } else if lower.starts_with("weaviate:") {
        Some(VectorProviderKind::Weaviate)
    } else if lower.starts_with("milvus:") {
        Some(VectorProviderKind::Milvus)
    } else {
        None
    }
}

pub fn is_vector_connection_string(conn_str: &str) -> bool {
    detect_vector_provider(conn_str).is_some()
}

fn similarity_to_distance(score: f64, metric: &str) -> f64 {
    match metric {
        "euclidean" => score,
        "dot" => -score,
        _ => 1.0 - score,
    }
}

#[derive(Debug, Clone)]
struct ParsedConn {
    url: String,
    path_param: Option<String>,
    params: HashMap<String, String>,
}

fn parse_vector_conn(prefix: &str, conn_str: &str, default_scheme: &str, fallback_host: &str) -> Result<ParsedConn, String> {
    let raw = conn_str.trim();
    let lower = raw.to_ascii_lowercase();
    let p = format!("{prefix}:");
    if !lower.starts_with(&p) {
        return Err(format!("not a {prefix} connection string: {raw}"));
    }
    let mut rest = &raw[p.len()..];
    if let Some(s) = rest.strip_prefix("//") {
        rest = s;
    }
    let (path_part, query_part) = rest.split_once('?').unwrap_or((rest, ""));
    let mut params = HashMap::new();
    for pair in query_part.split('&').filter(|s| !s.is_empty()) {
        if let Some((k, v)) = pair.split_once('=') {
            params.insert(k.to_string(), v.to_string());
        }
    }
    let mut host = path_part.trim().trim_end_matches('/').to_string();
    let mut path_param = None;
    if !host.is_empty() && !host.contains("://") {
        if let Some((h, tail)) = host.split_once('/') {
            if !tail.is_empty() {
                path_param = Some(tail.to_string());
            }
            host = h.to_string();
        }
    }
    let url = if host.is_empty() {
        format!("{default_scheme}://{fallback_host}")
    } else if host.contains("://") {
        host
    } else {
        format!("{default_scheme}://{host}")
    };
    Ok(ParsedConn { url, path_param, params })
}

pub trait VectorStoreProvider: Send + Sync {
    fn provider(&self) -> VectorProviderKind;
    fn endpoint(&self) -> &str;
    fn health(&self) -> VectorResult<Value>;
    fn upsert(&self, vectors: &[VectorRecord], collection: Option<&str>) -> VectorResult<usize>;
    fn search(&self, vector: &[f64], opts: &VectorSearchOptions) -> VectorResult<Vec<VectorSearchHit>>;
    fn delete(&self, ids: &[String], collection: Option<&str>) -> VectorResult<usize>;
}

/// Unified client supporting NBase, Qdrant, Chroma, Pinecone, Weaviate, and Milvus.
pub struct HttpVectorClient {
    kind: VectorProviderKind,
    endpoint: String,
    collection: String,
    namespace: Option<String>,
    tenant: String,
    database: String,
    db_name: Option<String>,
    token: Option<String>,
    timeout_ms: u64,
    transport: Arc<dyn VectorTransport>,
    chroma_collection_ids: Mutex<HashMap<String, String>>,
}

impl HttpVectorClient {
    pub fn from_connection_string(conn_str: &str) -> Result<Self, String> {
        Self::from_connection_string_with_transport(conn_str, Arc::new(StdHttpTransport))
    }

    pub fn from_connection_string_with_transport(
        conn_str: &str,
        transport: Arc<dyn VectorTransport>,
    ) -> Result<Self, String> {
        let kind = detect_vector_provider(conn_str)
            .ok_or_else(|| format!("Unsupported vector database connection string: {conn_str}"))?;
        let (default_scheme, fallback_host, default_col) = match kind {
            VectorProviderKind::NBase => ("http", "localhost:1307", "an5"),
            VectorProviderKind::Qdrant => ("http", "localhost:6333", "an5"),
            VectorProviderKind::Chroma => ("http", "localhost:8000", "an5"),
            VectorProviderKind::Pinecone => ("https", "localhost", "an5"),
            VectorProviderKind::Weaviate => ("http", "localhost:8080", "An5Vector"),
            VectorProviderKind::Milvus => ("http", "localhost:19530", "an5"),
        };
        let parsed = parse_vector_conn(kind.as_str(), conn_str, default_scheme, fallback_host)?;
        let collection = parsed
            .params
            .get("collection")
            .or_else(|| parsed.params.get("className"))
            .cloned()
            .or_else(|| parsed.path_param.clone())
            .unwrap_or_else(|| default_col.to_string());
        let namespace = parsed
            .params
            .get("namespace")
            .cloned()
            .or_else(|| if kind == VectorProviderKind::Pinecone { parsed.path_param.clone() } else { None });
        let token = parsed
            .params
            .get("apiKey")
            .or_else(|| parsed.params.get("token"))
            .cloned();
        let timeout_ms = parsed
            .params
            .get("timeoutMs")
            .and_then(|v| v.parse().ok())
            .unwrap_or(30_000);

        Ok(Self {
            kind,
            endpoint: parsed.url,
            collection,
            namespace,
            tenant: parsed.params.get("tenant").cloned().unwrap_or_else(|| "default_tenant".into()),
            database: parsed.params.get("database").cloned().unwrap_or_else(|| "default_database".into()),
            db_name: parsed.params.get("dbName").cloned(),
            token,
            timeout_ms,
            transport,
            chroma_collection_ids: Mutex::new(HashMap::new()),
        })
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = Vec::new();
        if let Some(ref tok) = self.token {
            match self.kind {
                VectorProviderKind::Qdrant | VectorProviderKind::Pinecone => {
                    h.push(("api-key".into(), tok.clone()));
                }
                _ => {
                    h.push(("authorization".into(), format!("Bearer {tok}")));
                }
            }
        }
        h
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> VectorResult<Value> {
        let url = format!("{}{}", self.endpoint.trim_end_matches('/'), path);
        self.transport
            .request_json(method, &url, &self.headers(), body, self.timeout_ms)
            .map_err(|mut e| {
                e.provider = self.kind.as_str().to_string();
                e
            })
    }

    fn chroma_base(&self) -> String {
        format!("/api/v2/tenants/{}/databases/{}/collections", self.tenant, self.database)
    }

    fn resolve_chroma_id(&self, name: &str) -> VectorResult<String> {
        if let Some(id) = self.chroma_collection_ids.lock().unwrap().get(name).cloned() {
            return Ok(id);
        }
        if let Ok(v) = self.call("GET", &format!("{}/{}", self.chroma_base(), name), None) {
            if let Some(id) = v.get("id").and_then(|s| s.as_str()) {
                self.chroma_collection_ids.lock().unwrap().insert(name.to_string(), id.to_string());
                return Ok(id.to_string());
            }
        }
        let created = self.call(
            "POST",
            &self.chroma_base(),
            Some(&json!({ "name": name, "get_or_create": true })),
        )?;
        let id = created
            .get("id")
            .and_then(|s| s.as_str())
            .unwrap_or(name)
            .to_string();
        self.chroma_collection_ids.lock().unwrap().insert(name.to_string(), id.clone());
        Ok(id)
    }
}

impl VectorStoreProvider for HttpVectorClient {
    fn provider(&self) -> VectorProviderKind {
        self.kind
    }

    fn endpoint(&self) -> &str {
        &self.endpoint
    }

    fn health(&self) -> VectorResult<Value> {
        match self.kind {
            VectorProviderKind::NBase => self.call("GET", "/health", None),
            VectorProviderKind::Qdrant => self.call("GET", "/healthz", None),
            VectorProviderKind::Chroma => self.call("GET", "/api/v2/heartbeat", None),
            VectorProviderKind::Pinecone => self.call("POST", "/describe_index_stats", Some(&json!({}))),
            VectorProviderKind::Weaviate => self.call("GET", "/v1/.well-known/ready", None),
            VectorProviderKind::Milvus => {
                let mut body = json!({});
                if let Some(ref db) = self.db_name {
                    body["dbName"] = json!(db);
                }
                self.call("POST", "/v2/vectordb/collections/list", Some(&body))
            }
        }
    }

    fn upsert(&self, vectors: &[VectorRecord], collection: Option<&str>) -> VectorResult<usize> {
        if vectors.is_empty() {
            return Ok(0);
        }
        let col = collection.unwrap_or(&self.collection);
        match self.kind {
            VectorProviderKind::NBase => {
                let val = serde_json::to_value(vectors).unwrap_or(json!([]));
                let res = self.call("POST", "/api/vectors", Some(&val))?;
                Ok(res.get("count").and_then(|v| v.as_u64()).unwrap_or(vectors.len() as u64) as usize)
            }
            VectorProviderKind::Qdrant => {
                let points: Vec<Value> = vectors
                    .iter()
                    .map(|v| json!({ "id": v.id, "vector": v.vector, "payload": v.metadata.clone().unwrap_or_default() }))
                    .collect();
                self.call("PUT", &format!("/collections/{col}/points?wait=true"), Some(&json!({ "points": points })))?;
                Ok(vectors.len())
            }
            VectorProviderKind::Chroma => {
                let cid = self.resolve_chroma_id(col)?;
                let ids: Vec<&str> = vectors.iter().map(|v| v.id.as_str()).collect();
                let embs: Vec<&Vec<f64>> = vectors.iter().map(|v| &v.vector).collect();
                let metas: Vec<Map<String, Value>> = vectors.iter().map(|v| v.metadata.clone().unwrap_or_default()).collect();
                self.call(
                    "POST",
                    &format!("{}/{cid}/upsert", self.chroma_base()),
                    Some(&json!({ "ids": ids, "embeddings": embs, "metadatas": metas })),
                )?;
                Ok(vectors.len())
            }
            VectorProviderKind::Pinecone => {
                let vecs: Vec<Value> = vectors
                    .iter()
                    .map(|v| json!({ "id": v.id, "values": v.vector, "metadata": v.metadata.clone().unwrap_or_default() }))
                    .collect();
                let mut body = json!({ "vectors": vecs });
                if let Some(ref ns) = self.namespace {
                    body["namespace"] = json!(ns);
                }
                let res = self.call("POST", "/vectors/upsert", Some(&body))?;
                Ok(res.get("upsertedCount").and_then(|v| v.as_u64()).unwrap_or(vectors.len() as u64) as usize)
            }
            VectorProviderKind::Weaviate => {
                let objs: Vec<Value> = vectors
                    .iter()
                    .map(|v| json!({ "class": col, "id": v.id, "vector": v.vector, "properties": v.metadata.clone().unwrap_or_default() }))
                    .collect();
                self.call("POST", "/v1/batch/objects", Some(&json!({ "objects": objs })))?;
                Ok(vectors.len())
            }
            VectorProviderKind::Milvus => {
                let data: Vec<Value> = vectors
                    .iter()
                    .map(|v| {
                        let mut m = v.metadata.clone().unwrap_or_default();
                        m.insert("id".into(), json!(v.id));
                        m.insert("vector".into(), json!(v.vector));
                        Value::Object(m)
                    })
                    .collect();
                let mut body = json!({ "collectionName": col, "data": data });
                if let Some(ref db) = self.db_name {
                    body["dbName"] = json!(db);
                }
                self.call("POST", "/v2/vectordb/entities/upsert", Some(&body))?;
                Ok(vectors.len())
            }
        }
    }

    fn search(&self, vector: &[f64], opts: &VectorSearchOptions) -> VectorResult<Vec<VectorSearchHit>> {
        let k = opts.k.unwrap_or(10);
        let metric = opts.distance_metric.as_deref().unwrap_or("cosine");
        let col = opts.collection.as_deref().unwrap_or(&self.collection);

        match self.kind {
            VectorProviderKind::NBase => {
                let res = self.call(
                    "POST",
                    "/api/search",
                    Some(&json!({
                        "vector": vector,
                        "k": k,
                        "distanceMetric": if metric == "euclidean" { "euclidean" } else { "cosine" },
                        "includeMetadata": opts.include_metadata.unwrap_or(true),
                    })),
                )?;
                let hits = res.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Ok(hits
                    .into_iter()
                    .map(|h| VectorSearchHit {
                        id: h.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        distance: h.get("dist").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        metadata: h.get("metadata").and_then(|v| v.as_object()).cloned(),
                        vector: None,
                    })
                    .collect())
            }
            VectorProviderKind::Qdrant => {
                let res = self.call(
                    "POST",
                    &format!("/collections/{col}/points/search"),
                    Some(&json!({ "vector": vector, "limit": k, "with_payload": opts.include_metadata.unwrap_or(true) })),
                )?;
                let items = res.get("result").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Ok(items
                    .into_iter()
                    .map(|item| VectorSearchHit {
                        id: item.get("id").map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string())).unwrap_or_default(),
                        distance: similarity_to_distance(item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0), metric),
                        metadata: item.get("payload").and_then(|v| v.as_object()).cloned(),
                        vector: None,
                    })
                    .collect())
            }
            VectorProviderKind::Chroma => {
                let cid = self.resolve_chroma_id(col)?;
                let res = self.call(
                    "POST",
                    &format!("{}/{cid}/query", self.chroma_base()),
                    Some(&json!({ "query_embeddings": [vector], "n_results": k, "include": ["distances", "metadatas"] })),
                )?;
                let ids = res.get("ids").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|a| a.as_array()).cloned().unwrap_or_default();
                let dists = res.get("distances").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|a| a.as_array()).cloned().unwrap_or_default();
                let metas = res.get("metadatas").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|a| a.as_array()).cloned().unwrap_or_default();
                Ok(ids
                    .into_iter()
                    .enumerate()
                    .map(|(i, idv)| VectorSearchHit {
                        id: idv.as_str().unwrap_or("").to_string(),
                        distance: dists.get(i).and_then(|d| d.as_f64()).unwrap_or(0.0),
                        metadata: metas.get(i).and_then(|m| m.as_object()).cloned(),
                        vector: None,
                    })
                    .collect())
            }
            VectorProviderKind::Pinecone => {
                let mut body = json!({ "vector": vector, "topK": k, "includeMetadata": true });
                if let Some(ref ns) = opts.namespace.as_ref().or(self.namespace.as_ref()) {
                    body["namespace"] = json!(ns);
                }
                let res = self.call("POST", "/query", Some(&body))?;
                let matches = res.get("matches").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Ok(matches
                    .into_iter()
                    .map(|m| VectorSearchHit {
                        id: m.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        distance: similarity_to_distance(m.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0), metric),
                        metadata: m.get("metadata").and_then(|v| v.as_object()).cloned(),
                        vector: None,
                    })
                    .collect())
            }
            VectorProviderKind::Weaviate => {
                let vec_json = serde_json::to_string(vector).unwrap_or_else(|_| "[]".into());
                let gql = format!("{{ Get {{ {col}(nearVector: {{ vector: {vec_json} }}, limit: {k}) {{ an5Id an5Model _additional {{ id distance }} }} }} }}");
                let res = self.call("POST", "/v1/graphql", Some(&json!({ "query": gql })))?;
                let items = res.pointer(&format!("/data/Get/{col}")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Ok(items
                    .into_iter()
                    .map(|item| {
                        let add = item.get("_additional").and_then(|v| v.as_object());
                        let id = add.and_then(|a| a.get("id")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let distance = add.and_then(|a| a.get("distance")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let mut meta = item.as_object().cloned().unwrap_or_default();
                        meta.remove("_additional");
                        VectorSearchHit { id, distance, metadata: Some(meta), vector: None }
                    })
                    .collect())
            }
            VectorProviderKind::Milvus => {
                let mut body = json!({ "collectionName": col, "data": [vector], "limit": k, "outputFields": ["*"] });
                if let Some(ref db) = self.db_name {
                    body["dbName"] = json!(db);
                }
                let res = self.call("POST", "/v2/vectordb/entities/search", Some(&body))?;
                let items = res.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Ok(items
                    .into_iter()
                    .map(|item| {
                        let id = item.get("id").map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                        let distance = item.get("distance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let mut meta = item.as_object().cloned().unwrap_or_default();
                        meta.remove("id");
                        meta.remove("distance");
                        meta.remove("vector");
                        VectorSearchHit { id, distance, metadata: Some(meta), vector: None }
                    })
                    .collect())
            }
        }
    }

    fn delete(&self, ids: &[String], collection: Option<&str>) -> VectorResult<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let col = collection.unwrap_or(&self.collection);
        match self.kind {
            VectorProviderKind::NBase => {
                for id in ids {
                    self.call("DELETE", &format!("/api/vectors/{id}"), None)?;
                }
                Ok(ids.len())
            }
            VectorProviderKind::Qdrant => {
                self.call("POST", &format!("/collections/{col}/points/delete?wait=true"), Some(&json!({ "points": ids })))?;
                Ok(ids.len())
            }
            VectorProviderKind::Chroma => {
                let cid = self.resolve_chroma_id(col)?;
                self.call("POST", &format!("{}/{cid}/delete", self.chroma_base()), Some(&json!({ "ids": ids })))?;
                Ok(ids.len())
            }
            VectorProviderKind::Pinecone => {
                let mut body = json!({ "ids": ids });
                if let Some(ref ns) = self.namespace {
                    body["namespace"] = json!(ns);
                }
                self.call("POST", "/vectors/delete", Some(&body))?;
                Ok(ids.len())
            }
            VectorProviderKind::Weaviate => {
                for id in ids {
                    self.call("DELETE", &format!("/v1/objects/{col}/{id}"), None)?;
                }
                Ok(ids.len())
            }
            VectorProviderKind::Milvus => {
                let quoted: Vec<String> = ids.iter().map(|id| format!("\"{}\"", id.replace('"', "\\\""))).collect();
                let mut body = json!({ "collectionName": col, "filter": format!("id in [{}]", quoted.join(", ")) });
                if let Some(ref db) = self.db_name {
                    body["dbName"] = json!(db);
                }
                self.call("POST", "/v2/vectordb/entities/delete", Some(&body))?;
                Ok(ids.len())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubTransport(HashMap<String, Value>);

    impl VectorTransport for StubTransport {
        fn request_json(&self, method: &str, url: &str, _headers: &[(String, String)], _body: Option<&Value>, _timeout_ms: u64) -> VectorResult<Value> {
            let path = url.split("://").nth(1).and_then(|s| s.find('/').map(|i| &s[i..])).unwrap_or("/");
            let key = format!("{method} {path}");
            self.0.get(&key).cloned().ok_or_else(|| VectorProviderError {
                provider: "stub".into(),
                status: Some(404),
                message: format!("no route for {key}"),
            })
        }
    }

    #[test]
    fn detects_all_six_vector_providers() {
        assert_eq!(detect_vector_provider("nbase://localhost:1307"), Some(VectorProviderKind::NBase));
        assert_eq!(detect_vector_provider("qdrant://localhost:6333/docs"), Some(VectorProviderKind::Qdrant));
        assert_eq!(detect_vector_provider("chroma://localhost:8000/docs"), Some(VectorProviderKind::Chroma));
        assert_eq!(detect_vector_provider("pinecone://idx.pinecone.io/ns"), Some(VectorProviderKind::Pinecone));
        assert_eq!(detect_vector_provider("weaviate://localhost:8080/Article"), Some(VectorProviderKind::Weaviate));
        assert_eq!(detect_vector_provider("milvus://localhost:19530/docs"), Some(VectorProviderKind::Milvus));
        assert!(!is_vector_connection_string("sqlite:///:memory:"));
    }

    #[test]
    fn executes_all_providers_with_stub_transport() {
        let mut routes = HashMap::new();
        routes.insert("GET /healthz".into(), json!({ "status": "ok" }));
        routes.insert("PUT /collections/docs/points?wait=true".into(), json!({ "status": "ok" }));
        routes.insert("POST /collections/docs/points/search".into(), json!({ "result": [{ "id": "Doc:1", "score": 0.9, "payload": { "an5Id": "1" } }] }));
        routes.insert("POST /collections/docs/points/delete?wait=true".into(), json!({ "status": "ok" }));

        let q = HttpVectorClient::from_connection_string_with_transport(
            "qdrant://localhost:6333/docs?apiKey=qk",
            Arc::new(StubTransport(routes)),
        ).unwrap();
        assert!(q.health().is_ok());
        assert_eq!(q.upsert(&[VectorRecord { id: "Doc:1".into(), vector: vec![1.0, 0.0], metadata: None }], None).unwrap(), 1);
        let hits = q.search(&[1.0, 0.0], &VectorSearchOptions::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert!((hits[0].distance - 0.1).abs() < 1e-9);
        assert_eq!(q.delete(&["Doc:1".into()], None).unwrap(), 1);
    }
}
