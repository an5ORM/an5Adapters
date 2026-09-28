/**
 * Tests for the NBase (Neural Vector Database) client and its integration with
 * the an5 adapter's vector search.
 *
 * The NBase HTTP API is faked with a stub fetch, so the suite runs offline.
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  NBaseVectorClient,
  NBaseError,
  parseNBaseConnectionString,
  createNBaseClient,
  buildVectorId,
  parseVectorId,
} = require(path.join(root, 'dist', 'nbase', 'index.js'));
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
    console.log(`    ${err.message}`);
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

/** Builds a fetch stub that answers from a route table. */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const method = (init?.method || 'GET').toUpperCase();
    const key = `${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body) : undefined });
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

function client(routes) {
  const { impl, calls } = stubFetch(routes);
  return {
    calls,
    nbase: new NBaseVectorClient({ url: 'http://localhost:1307', fetchImpl: impl }),
  };
}

// ─── Connection strings ───────────────────────────────────────────────────────

console.log('\nConnection string:');

test('parses nbase:// with host, port and token', () => {
  const config = parseNBaseConnectionString('nbase://db.internal:1307/vectors?token=secret');
  // A path is kept as a base path, for deployments behind a reverse proxy.
  assert.strictEqual(config.url, 'http://db.internal:1307/vectors');
  assert.strictEqual(config.token, 'secret');
});

test('defaults to localhost:1307', () => {
  assert.strictEqual(parseNBaseConnectionString('nbase://').url, 'http://localhost:1307');
});

test('rejects a non-nbase connection string', () => {
  assert.throws(() => parseNBaseConnectionString('sqlserver://localhost:1433'), /Not an NBase/);
});

test('builds and parses vector ids', () => {
  const id = buildVectorId('User', 'u1');
  assert.strictEqual(id, 'User:u1');
  assert.deepStrictEqual(parseVectorId(id), { model: 'User', id: 'u1' });
  assert.deepStrictEqual(parseVectorId('42'), { model: '', id: '42' });
});

test('createNBaseClient accepts a string or an object', () => {
  assert.ok(createNBaseClient('nbase://localhost:1307').client);
  assert.ok(createNBaseClient({ url: 'http://localhost:1307' }).client);
});

// ─── REST client ──────────────────────────────────────────────────────────────

console.log('\nREST client:');

async function main() {
  await atest('health() hits /health', async () => {
    const { nbase, calls } = client({ 'GET /health': { body: { status: 'ok', version: '0.1.10' } } });
    const health = await nbase.health();
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.version, '0.1.10');
    assert.ok(calls.some((c) => c.key === 'GET /health'));
  });

  await atest('addVectors() posts a single vector unwrapped', async () => {
    const { nbase, calls } = client({ 'POST /api/vectors': { body: { success: true, count: 1, addedIds: ['User:u1'] } } });
    const result = await nbase.addVectors([{ id: 'User:u1', vector: [1, 2, 3] }]);
    assert.strictEqual(result.count, 1);
    assert.deepStrictEqual(calls[0].body.vectors, { id: 'User:u1', vector: [1, 2, 3] });
  });

  await atest('addVectors() posts a bulk array for many vectors', async () => {
    const { nbase, calls } = client({ 'POST /api/vectors': { body: { success: true, count: 2 } } });
    await nbase.addVectors([
      { id: 'User:u1', vector: [1, 2] },
      { id: 'User:u2', vector: [3, 4] },
    ]);
    assert.ok(Array.isArray(calls[0].body.vectors));
    assert.strictEqual(calls[0].body.vectors.length, 2);
  });

  await atest('search() sends the query vector and returns ordered results', async () => {
    const { nbase, calls } = client({
      'POST /api/search': {
        body: { results: [{ id: 'User:u1', dist: 0.1 }, { id: 'User:u2', dist: 0.4 }], count: 2 },
      },
    });
    const results = await nbase.search([1, 2, 3], { k: 2, distanceMetric: 'cosine', method: 'hnsw' });
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].dist, 0.1);
    assert.deepStrictEqual(calls[0].body.query, [1, 2, 3]);
    assert.strictEqual(calls[0].body.k, 2);
    assert.strictEqual(calls[0].body.distanceMetric, 'cosine');
    assert.strictEqual(calls[0].body.method, 'hnsw');
  });

  await atest('get() returns undefined for a missing id', async () => {
    const { nbase } = client({ 'GET /api/vectors/missing': { status: 404, body: { error: 'not found' } } });
    assert.strictEqual(await nbase.get('missing'), undefined);
  });

  await atest('delete() and updateMetadata() call the right routes', async () => {
    const { nbase, calls } = client({
      'DELETE /api/vectors/User%3Au1': { body: { success: true } },
      'PATCH /api/vectors/User%3Au1/metadata': { body: { success: true } },
    });
    await nbase.delete('User:u1');
    await nbase.updateMetadata('User:u1', { label: 'vip' });
    assert.ok(calls.some((c) => c.key.startsWith('DELETE')));
    assert.ok(calls.some((c) => c.key.startsWith('PATCH')));
  });

  await atest('an HTTP error is surfaced with the server message', async () => {
    const { nbase } = client({ 'POST /api/search': { status: 400, body: { error: 'query vector array is required' } } });
    await assert.rejects(() => nbase.search([]), (err) => {
      assert.ok(err instanceof NBaseError);
      assert.ok(err.message.includes('query vector array is required'));
      return true;
    });
  });

  await atest('an unreachable server reports the base URL', async () => {
    const nbase = new NBaseVectorClient({
      url: 'http://nope:1307',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    await assert.rejects(() => nbase.health(), (err) => {
      assert.ok(err instanceof NBaseError);
      assert.ok(err.message.includes('http://nope:1307'));
      return true;
    });
  });

  await atest('the bearer token is sent when configured', async () => {
    const { impl, calls } = stubFetch({ 'GET /health': { body: { status: 'ok' } } });
    let seen = null;
    const nbase = new NBaseVectorClient({
      url: 'http://localhost:1307',
      token: 'secret',
      fetchImpl: (url, init) => { seen = init.headers; return impl(url, init); },
    });
    await nbase.health();
    assert.strictEqual(seen.authorization, 'Bearer secret');
  });

  // ─── Adapter integration ──────────────────────────────────────────────────────

  console.log('\nAdapter integration:');

  setAdapterMetadata({
    modelToTable: { User: '[dbo].[users]' },
    modelFields: { User: { id: { ts: 'string', sql: 'NVARCHAR(1000)' }, email: { ts: 'string', sql: 'NVARCHAR(255)' } } },
    relationMap: {},
  });

  /**
   * A QueryEngine stub. The adapter delegates every query to the engine, so
   * this is where SQL is captured, and it also supplies the dialect.
   */
  function fakeEngine(rowsFor) {
    const execCalls = [];
    return {
      execCalls,
      engine: {
        dialect: 'mssql',
        exec: async (query, params) => {
          execCalls.push({ query, params });
          return rowsFor(query, params);
        },
        executeRaw: async () => 1,
        connect: async () => {},
        disconnect: async () => {},
        beginTransaction: async () => { throw new Error('not used'); },
      },
    };
  }

  /** Adapter with a stubbed SQL engine and a stubbed NBase instance. */
  function setupAdapter(nbaseRoutes) {
    const { impl, calls } = stubFetch(nbaseRoutes);
    const { engine, execCalls } = fakeEngine((query, params) => {
      // Return one row per id the query asked for.
      return Object.keys(params ?? {})
        .filter((k) => k.startsWith('nbase_id_'))
        .map((k) => {
          const id = String(params[k]);
          return { id, email: id.endsWith('u1') ? 'alice@example.com' : 'bob@example.com', __an5_nbase_key: id };
        });
    });
    const db = createAn5Adapter({
      connectionString: 'sqlserver://localhost:1433;database=test',
      engine,
      nbase: { url: 'http://localhost:1307', fetchImpl: impl },
    });
    return { db, nbaseCalls: calls, execCalls };
  }

  await atest('vectorSearch queries NBase and hydrates rows from the table', async () => {
    const { db, nbaseCalls, execCalls } = setupAdapter({
      'POST /api/search': {
        body: {
          results: [
            { id: 'User:u1', dist: 0.12, metadata: { an5Id: 'u1', an5Model: 'User' } },
            { id: 'User:u2', dist: 0.34, metadata: { an5Id: 'u2', an5Model: 'User' } },
          ],
        },
      },
    });

    const rows = await db.table('User').vectorSearch({ vector: [1, 0, 0], take: 2 });

    assert.ok(nbaseCalls.some((c) => c.key === 'POST /api/search'), 'NBase should receive the search');
    assert.strictEqual(execCalls.length, 1, 'rows should be read from the relational table');
    assert.ok(execCalls[0].query.includes('FROM [dbo].[users]'), execCalls[0].query);
    assert.ok(execCalls[0].query.includes('IN ('));

    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].email, 'alice@example.com');
    assert.strictEqual(rows[0].distance, 0.12);
    assert.strictEqual(rows[1].distance, 0.34);
    assert.ok(!('__an5_nbase_key' in rows[0]), 'internal key column must not leak');
  });

  await atest('a dot-product request maps to the cosine metric', async () => {
    const { db, nbaseCalls } = setupAdapter({
      'POST /api/search': { body: { results: [{ id: 'User:u1', dist: 0.5, metadata: { an5Id: 'u1' } }] } },
    });
    await db.table('User').vectorSearch({ vector: [1, 0], distanceMetric: 'dot' });
    const search = nbaseCalls.find((c) => c.key === 'POST /api/search');
    assert.strictEqual(search.body.distanceMetric, 'cosine');
  });

  await atest('a NBase outage falls back to the database instead of failing', async () => {
    const { engine, execCalls } = fakeEngine(() => []);
    const db = createAn5Adapter({
      connectionString: 'sqlserver://localhost:1433;database=test',
      engine,
      nbase: { url: 'http://down:1307', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
    });

    const rows = await db.table('User').vectorSearch({ vector: [1, 0], take: 3 });
    assert.ok(Array.isArray(rows));
    assert.ok(execCalls.length > 0, 'should have fallen back to SQL');
    assert.ok(execCalls[0].query.includes('VECTOR_DISTANCE'), execCalls[0].query);
  });

  await atest('no NBase configured keeps the existing native path', async () => {
    const { engine, execCalls } = fakeEngine(() => []);
    const db = createAn5Adapter({ connectionString: 'sqlserver://localhost:1433;database=test', engine });
    await db.table('User').vectorSearch({ vector: [1, 0], take: 3 });
    assert.ok(execCalls[0].query.includes('VECTOR_DISTANCE'));
  });

  await atest('indexVectorsInNBase pushes embeddings with the row id in metadata', async () => {
    const { impl, calls } = stubFetch({ 'POST /api/vectors': { body: { success: true, count: 2 } } });
    const { engine } = fakeEngine(() => [
      { id: 'u1', email: 'alice@example.com', embedding: JSON.stringify([1, 2]) },
      { id: 'u2', email: 'bob@example.com', embedding: JSON.stringify([3, 4]) },
    ]);
    const db = createAn5Adapter({
      connectionString: 'sqlserver://localhost:1433;database=test',
      engine,
      nbase: { url: 'http://localhost:1307', fetchImpl: impl },
    });
    const nbaseCalls = calls;

    const result = await db.table('User').indexVectorsInNBase({ vectorField: 'embedding' });
    assert.strictEqual(result.indexed, 2);

    const payload = nbaseCalls.find((c) => c.key === 'POST /api/vectors').body.vectors;
    assert.strictEqual(payload[0].id, 'User:u1');
    assert.deepStrictEqual(payload[0].vector, [1, 2]);
    assert.strictEqual(payload[0].metadata.an5Id, 'u1');
    assert.strictEqual(payload[0].metadata.an5Model, 'User');
  });

  await atest('indexVectorsInNBase explains itself when NBase is missing', async () => {
    const { engine } = fakeEngine(() => []);
    const db = createAn5Adapter({ connectionString: 'sqlserver://localhost:1433', engine });
    await assert.rejects(() => db.table('User').indexVectorsInNBase(), /No NBase instance configured/);
  });


  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
