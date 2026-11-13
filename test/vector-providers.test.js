/**
 * Tests for the unified vector database providers:
 * Qdrant, Chroma, Pinecone, Weaviate, Milvus, and NBase.
 *
 * Uses a stub fetch implementation so the suite runs completely offline.
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  VectorProviderError,
  QdrantVectorClient,
  parseQdrantConnectionString,
  isQdrantConnectionString,
  ChromaVectorClient,
  parseChromaConnectionString,
  isChromaConnectionString,
  PineconeVectorClient,
  parsePineconeConnectionString,
  isPineconeConnectionString,
  WeaviateVectorClient,
  parseWeaviateConnectionString,
  isWeaviateConnectionString,
  MilvusVectorClient,
  parseMilvusConnectionString,
  isMilvusConnectionString,
  detectVectorProvider,
  isVectorConnectionString,
  createVectorStore,
} = require(path.join(root, 'dist', 'vector', 'index.js'));
const { createAn5Adapter, setAdapterMetadata } = require(path.join(root, 'dist', 'index.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.stack || err.message}`);
  }
}

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const method = (init?.method || 'GET').toUpperCase();
    const cleanUrl = String(url).replace(/^https?:\/\/[^/]+/, '');
    const key = `${method} ${cleanUrl}`;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, headers: init?.headers || {}, body });
    const handler = routes[key];
    if (!handler) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route for ${key}` }) };
    }
    const result = typeof handler === 'function' ? handler(calls[calls.length - 1]) : handler;
    return {
      ok: result.status === undefined || result.status < 400,
      status: result.status ?? 200,
      text: async () => JSON.stringify(result.body ?? {}),
    };
  };
  return { impl, calls };
}

console.log('\nConnection string parsing & detection:');

test('detects all 6 vector providers', () => {
  assert.strictEqual(detectVectorProvider('nbase://localhost:1307'), 'nbase');
  assert.strictEqual(detectVectorProvider('qdrant://localhost:6333'), 'qdrant');
  assert.strictEqual(detectVectorProvider('chroma://localhost:8000'), 'chroma');
  assert.strictEqual(detectVectorProvider('pinecone://my-index.svc.pinecone.io'), 'pinecone');
  assert.strictEqual(detectVectorProvider('weaviate://localhost:8080'), 'weaviate');
  assert.strictEqual(detectVectorProvider('milvus://localhost:19530'), 'milvus');
  assert.strictEqual(detectVectorProvider('postgres://localhost:5432/db'), null);
  assert.strictEqual(isVectorConnectionString('qdrant://localhost:6333'), true);
  assert.strictEqual(isVectorConnectionString('sqlite:///:memory:'), false);
});

test('parses qdrant:// with collection and apiKey', () => {
  assert.strictEqual(isQdrantConnectionString('qdrant://localhost:6333'), true);
  const cfg = parseQdrantConnectionString('qdrant://qdrant.internal:6333/docs?apiKey=qk_123&timeoutMs=2500');
  assert.strictEqual(cfg.url, 'http://qdrant.internal:6333');
  assert.strictEqual(cfg.collection, 'docs');
  assert.strictEqual(cfg.apiKey, 'qk_123');
  assert.strictEqual(cfg.timeoutMs, 2500);
});

test('parses chroma:// with tenant, database, collection', () => {
  assert.strictEqual(isChromaConnectionString('chroma://localhost:8000'), true);
  const cfg = parseChromaConnectionString('chroma://chroma.local:8000/articles?tenant=t1&database=d1&token=ctok');
  assert.strictEqual(cfg.url, 'http://chroma.local:8000');
  assert.strictEqual(cfg.collection, 'articles');
  assert.strictEqual(cfg.tenant, 't1');
  assert.strictEqual(cfg.database, 'd1');
  assert.strictEqual(cfg.token, 'ctok');
});

test('parses pinecone:// defaulting to https and namespace', () => {
  assert.strictEqual(isPineconeConnectionString('pinecone://idx.svc.pinecone.io'), true);
  const cfg = parsePineconeConnectionString('pinecone://idx-123.svc.us-east1.pinecone.io/prod?apiKey=pc_key');
  assert.strictEqual(cfg.url, 'https://idx-123.svc.us-east1.pinecone.io');
  assert.strictEqual(cfg.namespace, 'prod');
  assert.strictEqual(cfg.apiKey, 'pc_key');
});

test('parses weaviate:// with className', () => {
  assert.strictEqual(isWeaviateConnectionString('weaviate://localhost:8080'), true);
  const cfg = parseWeaviateConnectionString('weaviate://weaviate.local:8080/Article?apiKey=w_key');
  assert.strictEqual(cfg.url, 'http://weaviate.local:8080');
  assert.strictEqual(cfg.className, 'Article');
  assert.strictEqual(cfg.apiKey, 'w_key');
});

test('parses milvus:// with collection and dbName', () => {
  assert.strictEqual(isMilvusConnectionString('milvus://localhost:19530'), true);
  const cfg = parseMilvusConnectionString('milvus://milvus.local:19530/docs?dbName=mydb&token=m_tok');
  assert.strictEqual(cfg.url, 'http://milvus.local:19530');
  assert.strictEqual(cfg.collection, 'docs');
  assert.strictEqual(cfg.dbName, 'mydb');
  assert.strictEqual(cfg.token, 'm_tok');
});

test('createVectorStore constructs each provider and rejects unknown schemes', () => {
  assert.strictEqual(createVectorStore('qdrant://localhost:6333').provider, 'qdrant');
  assert.strictEqual(createVectorStore('chroma://localhost:8000').provider, 'chroma');
  assert.strictEqual(createVectorStore('pinecone://idx.pinecone.io').provider, 'pinecone');
  assert.strictEqual(createVectorStore('weaviate://localhost:8080').provider, 'weaviate');
  assert.strictEqual(createVectorStore('milvus://localhost:19530').provider, 'milvus');
  assert.strictEqual(createVectorStore('nbase://localhost:1307').provider, 'nbase');
  assert.throws(() => createVectorStore('redis://localhost:6379'), /Unsupported vector database/);
});

async function main() {
  console.log('\nProvider REST clients:');

  await atest('Qdrant: health, upsert, search, delete', async () => {
    const { impl, calls } = stubFetch({
      'GET /healthz': { body: { status: 'ok', version: '1.12.0' } },
      'PUT /collections/docs/points?wait=true': { body: { status: 'ok' } },
      'POST /collections/docs/points/search': {
        body: {
          result: [
            { id: 'Article:1', score: 0.9, payload: { an5Id: '1', an5Model: 'Article' } },
          ],
        },
      },
      'POST /collections/docs/points/delete?wait=true': { body: { status: 'ok' } },
    });
    const client = new QdrantVectorClient({
      url: 'http://localhost:6333',
      collection: 'docs',
      apiKey: 'secret',
      fetchImpl: impl,
    });
    const h = await client.health();
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.provider, 'qdrant');

    const up = await client.upsert([{ id: 'Article:1', vector: [0.1, 0.2], metadata: { an5Id: '1' } }]);
    assert.strictEqual(up.count, 1);
    assert.strictEqual(calls[1].headers['api-key'], 'secret');

    const hits = await client.search([0.1, 0.2], { k: 5, distanceMetric: 'cosine' });
    assert.strictEqual(hits.length, 1);
    assert.ok(Math.abs(hits[0].distance - 0.1) < 1e-9);
    assert.strictEqual(hits[0].metadata.an5Id, '1');

    const del = await client.delete(['Article:1']);
    assert.strictEqual(del.deleted, 1);
  });

  await atest('Chroma: health, collection resolution, upsert, search, delete', async () => {
    const { impl } = stubFetch({
      'GET /api/v2/heartbeat': { body: { 'nanosecond heartbeat': 12345 } },
      'GET /api/v2/tenants/default_tenant/databases/default_database/collections/docs': {
        body: { id: 'col-uuid-1', name: 'docs' },
      },
      'POST /api/v2/tenants/default_tenant/databases/default_database/collections/col-uuid-1/upsert': {
        body: {},
      },
      'POST /api/v2/tenants/default_tenant/databases/default_database/collections/col-uuid-1/query': {
        body: {
          ids: [['Article:1']],
          distances: [[0.15]],
          metadatas: [[{ an5Id: '1', an5Model: 'Article' }]],
        },
      },
      'POST /api/v2/tenants/default_tenant/databases/default_database/collections/col-uuid-1/delete': {
        body: {},
      },
    });
    const client = new ChromaVectorClient({
      url: 'http://localhost:8000',
      collection: 'docs',
      fetchImpl: impl,
    });
    assert.strictEqual((await client.health()).ok, true);
    assert.strictEqual((await client.upsert([{ id: 'Article:1', vector: [1, 0], metadata: { an5Id: '1' } }])).count, 1);
    const hits = await client.search([1, 0], { k: 3 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].distance, 0.15);
    assert.strictEqual((await client.delete(['Article:1'])).deleted, 1);
  });

  await atest('Pinecone: health, upsert, query, delete', async () => {
    const { impl, calls } = stubFetch({
      'POST /describe_index_stats': { body: { totalVectorCount: 42 } },
      'POST /vectors/upsert': { body: { upsertedCount: 1 } },
      'POST /query': {
        body: {
          matches: [{ id: 'Article:2', score: 0.85, metadata: { an5Id: '2', an5Model: 'Article' } }],
        },
      },
      'POST /vectors/delete': { body: {} },
    });
    const client = new PineconeVectorClient({
      url: 'https://idx.pinecone.io',
      namespace: 'ns1',
      apiKey: 'pc_123',
      fetchImpl: impl,
    });
    assert.strictEqual((await client.health()).ok, true);
    assert.strictEqual((await client.upsert([{ id: 'Article:2', vector: [0.5, 0.5], metadata: { an5Id: '2' } }])).count, 1);
    assert.strictEqual(calls[1].headers['api-key'], 'pc_123');
    assert.strictEqual(calls[1].body.namespace, 'ns1');
    const hits = await client.search([0.5, 0.5], { k: 2 });
    assert.strictEqual(hits.length, 1);
    assert.ok(Math.abs(hits[0].distance - 0.15) < 1e-9);
    assert.strictEqual((await client.delete(['Article:2'])).deleted, 1);
  });

  await atest('Weaviate: health, batch upsert, graphql search, delete', async () => {
    const { impl } = stubFetch({
      'GET /v1/.well-known/ready': { body: {} },
      'POST /v1/batch/objects': { body: [] },
      'POST /v1/graphql': {
        body: {
          data: {
            Get: {
              Article: [
                { an5Id: '7', an5Model: 'Article', _additional: { id: 'uuid-7', distance: 0.08 } },
              ],
            },
          },
        },
      },
      'DELETE /v1/objects/Article/uuid-7': { body: {} },
    });
    const client = new WeaviateVectorClient({
      url: 'http://localhost:8080',
      className: 'Article',
      fetchImpl: impl,
    });
    assert.strictEqual((await client.health()).ok, true);
    assert.strictEqual((await client.upsert([{ id: 'uuid-7', vector: [0.2, 0.8], metadata: { an5Id: '7' } }])).count, 1);
    const hits = await client.search([0.2, 0.8], { k: 1 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'uuid-7');
    assert.strictEqual(hits[0].distance, 0.08);
    assert.strictEqual((await client.delete(['uuid-7'])).deleted, 1);
  });

  await atest('Milvus: health, upsert, search, delete', async () => {
    const { impl } = stubFetch({
      'POST /v2/vectordb/collections/list': { body: { code: 0, data: ['docs'] } },
      'POST /v2/vectordb/entities/upsert': { body: { code: 0, data: { upsertCount: 1 } } },
      'POST /v2/vectordb/entities/search': {
        body: {
          code: 0,
          data: [{ id: 'Article:9', distance: 0.12, an5Id: '9', an5Model: 'Article' }],
        },
      },
      'POST /v2/vectordb/entities/delete': { body: { code: 0 } },
    });
    const client = new MilvusVectorClient({
      url: 'http://localhost:19530',
      collection: 'docs',
      fetchImpl: impl,
    });
    assert.strictEqual((await client.health()).ok, true);
    assert.strictEqual((await client.upsert([{ id: 'Article:9', vector: [0.3, 0.7], metadata: { an5Id: '9' } }])).count, 1);
    const hits = await client.search([0.3, 0.7], { k: 4 });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].distance, 0.12);
    assert.strictEqual(hits[0].metadata.an5Id, '9');
    assert.strictEqual((await client.delete(['Article:9'])).deleted, 1);
  });

  console.log('\nAn5Adapter integration:');

  await atest('vector-only adapter works with qdrant:// connectionString', async () => {
    const db = createAn5Adapter({ connectionString: 'qdrant://localhost:6333/articles' });
    assert.strictEqual(db.vectorStoreOnly, true);
    assert.strictEqual(db.vectorStore().provider, 'qdrant');
  });

  await atest('sidecar vectorStore hydrates rows from relational table and supports indexVectors', async () => {
    const aliases = ['Doc', 'doc', 'Docs', 'docs'];
    const docFields = {
      id: { ts: 'string', sql: 'TEXT', isId: true },
      title: { ts: 'string', sql: 'TEXT' },
      embedding: { ts: 'number[] | string', sql: 'VECTOR(2)' },
    };
    setAdapterMetadata({
      modelToTable: Object.fromEntries(aliases.map((n) => [n, '[docs]'])),
      modelFields: Object.fromEntries(aliases.map((n) => [n, docFields])),
    });

    const { impl } = stubFetch({
      'GET /healthz': { body: { status: 'ok' } },
      'PUT /collections/docs/points?wait=true': { body: { status: 'ok' } },
      'POST /collections/docs/points/search': {
        body: {
          result: [
            { id: 'Doc:d2', score: 0.95, payload: { an5Id: 'd2', an5Model: 'Doc' } },
            { id: 'Doc:d1', score: 0.7, payload: { an5Id: 'd1', an5Model: 'Doc' } },
          ],
        },
      },
    });

    const store = new QdrantVectorClient({
      url: 'http://localhost:6333',
      collection: 'docs',
      fetchImpl: impl,
    });

    const db = createAn5Adapter({
      connectionString: 'sqlite::memory:',
      vectorStore: store,
    });
    await db.$connect();
    await db.$executeRaw('CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, embedding BLOB)');
    await db.doc.create({ data: { id: 'd1', title: 'First', embedding: [1, 0] } });
    await db.doc.create({ data: { id: 'd2', title: 'Second', embedding: [0, 1] } });

    const health = await db.$vectorHealth();
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.provider, 'qdrant');

    const indexed = await db.doc.indexVectors({ vectorField: 'embedding' });
    assert.strictEqual(indexed.indexed, 2);

    const results = await db.doc.vectorSearch({ vector: [0, 1], take: 2 });
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].id, 'd2');
    assert.strictEqual(results[0].title, 'Second');
    assert.ok(Math.abs(results[0].distance - 0.05) < 1e-9);
    await db.$disconnect();
  });

  await atest('vectorStore outage falls back to relational dialect instead of failing', async () => {
    const failingFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const store = new QdrantVectorClient({
      url: 'http://down:6333',
      collection: 'docs',
      fetchImpl: failingFetch,
    });
    const db = createAn5Adapter({
      connectionString: 'sqlite::memory:',
      vectorStore: store,
    });
    await db.$connect();
    await db.$executeRaw('CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, embedding BLOB)');
    await db.doc.create({ data: { id: 'd1', title: 'Fallback', embedding: [1, 0] } });

    const results = await db.doc.vectorSearch({ vector: [1, 0], take: 1 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'd1');
    await db.$disconnect();
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
