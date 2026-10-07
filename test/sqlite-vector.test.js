/**
 * Tests for SQLite vector search.
 *
 * A real in-memory SQLite file backs every case, so the four strategies —
 * sqlite-vec, a driver function, `json_each` in plain SQL, and the in-memory
 * fallback — are exercised against actual queries rather than a stub.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

let betterSqlite3 = null;
try { betterSqlite3 = require('better-sqlite3'); } catch { }

const { createAn5Adapter, setAdapterMetadata } = require(path.join(dist, 'index.js'));
const {
  encodeVector,
  decodeVector,
  vectorDistance,
  isVectorField,
  planSqliteVectorStrategies,
  AN5_VECTOR_FUNCTIONS,
  SQLITE_VEC_FUNCTIONS,
} = require(path.join(dist, 'sqlite', 'vector.js'));

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

const VECTORS = {
  d1: [1, 0, 0],
  d2: [0.8, 0.2, 0],
  d3: [0, 1, 0],
};

/** A SQLite file with a `VECTOR(n)`-style column and three documents. */
function makeDb({ declared = 'BLOB', store = 'blob', name } = {}) {
  const file = name ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'an5-vec-')), 'vec.sqlite3');
  const db = new betterSqlite3(file);
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding ${declared})`);
  const insert = db.prepare('INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)');
  for (const [id, vector] of Object.entries(VECTORS)) {
    const value = store === 'blob' ? encodeVector(vector) : store === 'json' ? JSON.stringify(vector) : null;
    insert.run(id, `doc ${id}`, value);
  }
  db.close();
  return file;
}

// The generator registers every casing of a model name, so the metadata has to
// carry the aliases too: a lookup by `db.document` finds the `document` entry.
const ALIASES = ['Document', 'document', 'Documents', 'documents'];
const FIELDS = {
  id: { ts: 'string', sql: 'TEXT', isId: true },
  title: { ts: 'string', sql: 'TEXT' },
  embedding: { ts: 'number[] | string', sql: 'VECTOR(3)' },
};
const METADATA = {
  modelToTable: Object.fromEntries(ALIASES.map((n) => [n, '[documents]'])),
  modelDescriptions: Object.fromEntries(ALIASES.map((n) => [n, undefined])),
  modelFields: Object.fromEntries(ALIASES.map((n) => [n, FIELDS])),
  relationMap: {},
};

/** Opens an adapter over a freshly created database file. */
function adapter(file, config = {}) {
  setAdapterMetadata(METADATA);
  return createAn5Adapter({ connectionString: file, ...config });
}

async function main() {
  if (!betterSqlite3) {
    console.log('  - skipped: better-sqlite3 is not installed');
    return;
  }

  console.log('SQLite vector codec');

  await test('encodeVector writes little-endian float32', () => {
    assert.deepStrictEqual([...encodeVector([1, -2, 0.5]).subarray(0, 4)], [0x00, 0x00, 0x80, 0x3f]);
    assert.strictEqual(encodeVector([1, 2, 3]).length, 12);
  });

  await test('decodeVector round-trips a BLOB', () => {
    assert.deepStrictEqual(decodeVector(encodeVector([0.25, -0.5, 3])), [0.25, -0.5, 3]);
  });

  await test('decodeVector still reads the legacy JSON text column', () => {
    assert.deepStrictEqual(decodeVector('[1, 0, 0]'), [1, 0, 0]);
    assert.deepStrictEqual(decodeVector('[0.1,0.2]'), [0.1, 0.2]);
  });

  await test('decodeVector passes an array through and rejects junk', () => {
    assert.deepStrictEqual(decodeVector([1, 2]), [1, 2]);
    assert.strictEqual(decodeVector(null), null);
    assert.strictEqual(decodeVector('not json'), null);
    assert.strictEqual(decodeVector(Buffer.alloc(3)), null);
    assert.strictEqual(decodeVector(''), null);
  });

  await test('vectorDistance matches the three documented metrics', () => {
    assert.ok(Math.abs(vectorDistance([1, 0], [1, 0], 'cosine')) < 1e-9);
    assert.ok(Math.abs(vectorDistance([1, 0], [0, 1], 'cosine') - 1) < 1e-9);
    assert.ok(Math.abs(vectorDistance([0, 3], [4, 0], 'euclidean') - 5) < 1e-9);
    assert.strictEqual(vectorDistance([1, 2], [2, 4], 'dot'), -10);
    assert.strictEqual(vectorDistance([1, 2], [1, 2, 3], 'cosine'), null);
  });

  await test('isVectorField recognises a VECTOR column in every metadata shape', () => {
    assert.strictEqual(isVectorField({ ts: 'number[] | string', sql: 'VECTOR(3)' }), true);
    assert.strictEqual(isVectorField({ ts: 'number[] | string' }), true);
    assert.strictEqual(isVectorField({ sql: 'VECTOR(1536)' }), true);
    assert.strictEqual(isVectorField({ kind: 'vector' }), true);
    assert.strictEqual(isVectorField({ ts: 'string', sql: 'NVARCHAR(255)' }), false);
    assert.strictEqual(isVectorField(undefined), false);
  });

  console.log('SQLite vector strategy order');

  await test('the plan prefers sqlite-vec, then the driver function, then JSON', () => {
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ vec: true, udf: true, json1: true }, 'BLOB'),
      ['sqlite-vec', 'udf'],
    );
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ vec: false, udf: true, json1: true }, 'BLOB'),
      ['udf'],
    );
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ vec: false, udf: false, json1: true }, 'TEXT'),
      ['sql'],
    );
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ vec: false, udf: false, json1: false }, 'TEXT'),
      [],
    );
  });

  await test('a BLOB column drops the JSON strategy, since there is no JSON to read', () => {
    assert.ok(!planSqliteVectorStrategies({ vec: false, udf: false, json1: true }, 'BLOB').includes('sql'));
  });

  await test('vectorStrategy pins the plan to the requested strategy', () => {
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ vec: true, udf: true, json1: true }, 'BLOB', 'udf'),
      ['udf'],
    );
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ vec: false, udf: false, json1: false }, 'TEXT', 'memory'),
      [],
    );
  });

  await test('the native C extension replaces the callback strategy', () => {
    // `native` implies the C functions exist, so the plan must not also offer
    // sqlite-vec: the C code covers dot product, which sqlite-vec 0.1.9 lacks.
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ native: true, vec: false, udf: true, json1: true }, 'BLOB'),
      ['udf'],
    );
  });

  await test('the native C extension wins over sqlite-vec when both load', () => {
    assert.deepStrictEqual(
      planSqliteVectorStrategies({ native: true, vec: true, udf: true, json1: true }, 'BLOB'),
      ['udf', 'sqlite-vec'],
    );
  });

  await test('the registered and extension function names are stable', () => {
    assert.deepStrictEqual(AN5_VECTOR_FUNCTIONS, {
      cosine: 'an5_vec_cosine',
      euclidean: 'an5_vec_l2',
      dot: 'an5_vec_ip',
    });
    assert.deepStrictEqual(SQLITE_VEC_FUNCTIONS, {
      cosine: 'vec_distance_cosine',
      euclidean: 'vec_distance_l2',
      dot: 'vec_distance_ip',
    });
  });

  console.log('SQLite vector search');

  await test('the driver function ranks a float32 BLOB column', async () => {
    const db = adapter(makeDb(), { vectorStrategy: 'udf' });
    try {
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 3, vectorStrategy: 'udf' });
      assert.deepStrictEqual(rows.map((r) => r.id), ['d1', 'd2', 'd3']);
      assert.ok(Math.abs(rows[0].distance) < 1e-9);
      assert.ok(rows[1].distance < rows[2].distance);
    } finally {
      await db.$disconnect();
    }
  });

  await test('the JSON strategy ranks a legacy TEXT column', async () => {
    const db = adapter(makeDb({ declared: 'TEXT', store: 'json' }), { vectorStrategy: 'sql' });
    try {
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 3, vectorStrategy: 'sql' });
      assert.deepStrictEqual(rows.map((r) => r.id), ['d1', 'd2', 'd3']);
      assert.ok(Math.abs(rows[0].distance) < 1e-9);
    } finally {
      await db.$disconnect();
    }
  });

  await test('the in-memory fallback reads BLOB columns too', async () => {
    const db = adapter(makeDb(), { vectorStrategy: 'memory' });
    try {
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 2, vectorStrategy: 'memory' });
      assert.deepStrictEqual(rows.map((r) => r.id), ['d1', 'd2']);
      assert.ok(Math.abs(rows[0].distance) < 1e-9);
    } finally {
      await db.$disconnect();
    }
  });

  await test('every metric ranks the same rows through the driver function', async () => {
    const file = makeDb();
    for (const metric of ['cosine', 'euclidean', 'dot']) {
      const db = adapter(file);
      try {
        const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 3, distanceMetric: metric });
        assert.deepStrictEqual(rows.map((r) => r.id), ['d1', 'd2', 'd3'], metric);
      } finally {
        await db.$disconnect();
      }
    }
  });

  await test('auto detection uses the driver function on a BLOB column', async () => {
    const file = makeDb();
    const db = adapter(file);
    try {
      // `udf` is the fastest strategy a plain better-sqlite3 connection has.
      const rows = await db.document.vectorSearch({ vector: [0.9, 0.1, 0], take: 1 });
      assert.deepStrictEqual(rows.map((r) => r.id), ['d1']);
    } finally {
      await db.$disconnect();
    }
  });

  await test('auto detection uses json_each on a TEXT column', async () => {
    const db = adapter(makeDb({ declared: 'TEXT', store: 'json' }));
    try {
      const rows = await db.document.vectorSearch({ vector: [0.9, 0.1, 0], take: 1 });
      assert.deepStrictEqual(rows.map((r) => r.id), ['d1']);
    } finally {
      await db.$disconnect();
    }
  });

  await test('a where filter is applied inside the ranking query', async () => {
    const db = adapter(makeDb());
    try {
      const rows = await db.document.vectorSearch({
        vector: [1, 0, 0],
        take: 5,
        where: { id: { in: ['d1', 'd3'] } },
      });
      assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['d1', 'd3']);
    } finally {
      await db.$disconnect();
    }
  });

  await test('a row whose vector has another dimension is left out', async () => {
    const file = makeDb();
    const raw = new betterSqlite3(file);
    raw.prepare('INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)')
      .run('d4', 'wrong size', encodeVector([1, 0, 0, 1]));
    raw.close();

    const db = adapter(file);
    try {
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 9 });
      assert.ok(!rows.some((r) => r.id === 'd4'), 'a 4-dimension row must not rank against a 3-dimension query');
    } finally {
      await db.$disconnect();
    }
  });

  await test('a NULL embedding never wins over a real one', async () => {
    const file = makeDb();
    const raw = new betterSqlite3(file);
    raw.prepare('INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)').run('d5', 'no vector', null);
    raw.close();

    const db = adapter(file);
    try {
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 9 });
      assert.deepStrictEqual(rows.map((r) => r.id), ['d1', 'd2', 'd3']);
      assert.ok(rows.every((r) => typeof r.distance === 'number'));
    } finally {
      await db.$disconnect();
    }
  });

  console.log('SQLite vector column round-trip');

  await test('mixed legacy TEXT and new BLOB values all participate in search', async () => {
    const file = makeDb({ declared: 'TEXT', store: 'json' });
    const db = adapter(file, { vectorStrategy: 'sql' });
    try {
      await db.document.create({ data: { id: 'new', title: 'new', embedding: [1, 0, 0] } });
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0], take: 10 });
      assert.deepStrictEqual(rows.map(r => r.id).sort(), ['d1', 'd2', 'd3', 'new']);
    } finally {
      await db.$disconnect();
    }
  });

  await test('browser SQLite round-trips and ranks BLOBs without a Buffer global', async () => {
    const init = require('sql.js');
    const SQL = await init();
    const raw = new SQL.Database();
    raw.run('CREATE TABLE documents(id TEXT PRIMARY KEY, title TEXT, embedding BLOB)');
    const { createBrowserSqliteAdapter } = require(path.join(dist, 'sqlite', 'browserEngine.js'));
    setAdapterMetadata(METADATA);
    const db = createBrowserSqliteAdapter({ db: raw });
    const savedBuffer = global.Buffer;
    try {
      global.Buffer = undefined;
      await db.document.create({ data: { id: 'browser', title: 'browser', embedding: [1, 0, 0] } });
      const rows = await db.document.vectorSearch({ vector: [1, 0, 0] });
      assert.deepStrictEqual(rows.map(r => r.id), ['browser']);
      assert.deepStrictEqual(rows[0].embedding, [1, 0, 0]);
      assert.equal(rows[0].distance, 0);
    } finally {
      global.Buffer = savedBuffer;
      await db.$disconnect();
    }
  });

  if (process.env.AN5_SQLITE_VEC_PATH) {
    await test('sqlite-vec ranks mixed JSON/BLOB rows with a WHERE filter', async () => {
      const file = makeDb();
      const raw = new betterSqlite3(file);
      raw.prepare('UPDATE documents SET embedding = ? WHERE id = ?').run('[0.8,0.2,0]', 'd2');
      raw.close();
      const db = adapter(file, { sqliteVec: process.env.AN5_SQLITE_VEC_PATH, vectorStrategy: 'sqlite-vec' });
      try {
        const support = await db.sqliteVectorSupport();
        assert.equal((await support.probe((q, p) => db.exec(q, p))).vec, true);
        for (const metric of ['cosine', 'euclidean']) {
          const { buildSqliteVectorQuery } = require(path.join(dist, 'sqlite', 'vector.js'));
          const native = buildSqliteVectorQuery({ strategy: 'sqlite-vec', metric, table: '[documents]', column: '[embedding]', vector: [1, 0, 0], take: 10, tail: ' WHERE id IN (@first, @second)', params: { first: 'd1', second: 'd2' } });
          assert.deepStrictEqual((await db.exec(native.sql, native.params)).map(r => r.id), ['d1', 'd2']);
          const rows = await db.document.vectorSearch({ vector: [1, 0, 0], distanceMetric: metric, where: { id: { in: ['d1', 'd2'] } } });
          assert.deepStrictEqual(rows.map(r => r.id), ['d1', 'd2']);
        }
      } finally {
        await db.$disconnect();
      }
    });
  }

  await test('create stores float32 bytes and findMany returns number[]', async () => {
    const file = makeDb({ declared: 'BLOB' });
    const db = adapter(file);
    try {
      const created = await db.document.create({
        data: { id: 'd9', title: 'written', embedding: [0.1, 0.2, 0.3] },
      });
      // float32 storage, so the values come back at single precision.
      assert.deepStrictEqual(created.embedding, [0.10000000149011612, 0.20000000298023224, 0.30000001192092896]);

      const rows = await db.document.findMany({ where: { id: 'd9' } });
      assert.deepStrictEqual(rows[0].embedding, [0.10000000149011612, 0.20000000298023224, 0.30000001192092896]);

      const raw = new betterSqlite3(file, { readonly: true });
      const stored = raw.prepare('SELECT typeof(embedding) AS t FROM documents WHERE id = ?').get('d9');
      raw.close();
      assert.strictEqual(stored.t, 'blob', 'a number[] must be written as a BLOB');
    } finally {
      await db.$disconnect();
    }
  });

  await test('update and updateMany encode the vector column', async () => {
    const db = adapter(makeDb({ declared: 'BLOB' }));
    try {
      await db.document.update({ where: { id: 'd1' }, data: { embedding: [0.5, 0.5, 0] } });
      const rows = await db.document.findMany({ where: { id: 'd1' } });
      assert.deepStrictEqual(rows[0].embedding, [0.5, 0.5, 0]);

      await db.document.updateMany({ where: { id: 'd2' }, data: { embedding: [0, 0, 1] } });
      const updated = await db.document.findMany({ where: { id: 'd2' } });
      assert.deepStrictEqual(updated[0].embedding, [0, 0, 1]);
    } finally {
      await db.$disconnect();
    }
  });

  await test('createMany encodes every row', async () => {
    const db = adapter(makeDb({ declared: 'BLOB' }));
    try {
      await db.document.createMany({
        data: [
          { id: 'm1', title: 'a', embedding: [1, 0, 0] },
          { id: 'm2', title: 'b', embedding: [0, 1, 0] },
        ],
      });
      const rows = await db.document.findMany({ where: { id: { in: ['m1', 'm2'] } }, orderBy: { id: 'asc' } });
      assert.deepStrictEqual(rows.map((r) => r.embedding), [[1, 0, 0], [0, 1, 0]]);
    } finally {
      await db.$disconnect();
    }
  });

  await test('a row written as JSON text is still returned as number[]', async () => {
    const file = makeDb({ declared: 'TEXT', store: 'json' });
    const db = adapter(file);
    try {
      const rows = await db.document.findMany({ where: { id: 'd1' } });
      assert.deepStrictEqual(rows[0].embedding, [1, 0, 0]);
    } finally {
      await db.$disconnect();
    }
  });

  await test('a non-vector column is never rewritten', async () => {
    const db = adapter(makeDb());
    try {
      const rows = await db.document.findMany({ where: { id: 'd1' } });
      assert.strictEqual(rows[0].title, 'doc d1');
    } finally {
      await db.$disconnect();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
