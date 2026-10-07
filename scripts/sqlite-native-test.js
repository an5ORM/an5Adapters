/* Build the real C extension in a disposable directory, then exercise its ABI
 * through SQLite and through the public adapter. Benchmarks are opt-in: timing
 * never determines whether correctness tests pass. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { buildNative } = require('./sqlite-native-build');
const { createAn5Adapter, encodeVector, decodeVector, vectorDistance } = require('../dist');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-sqlite-native-'));
const buffers = [];
let seed = 12345;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296 - 0.5;
}
const functions = { cosine: 'an5_vec_cosine', euclidean: 'an5_vec_l2', dot: 'an5_vec_ip' };
function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

async function main() {
  const binary = buildNative(temp);
  const db = new Database(':memory:');
  buffers.push(db);
  db.loadExtension(binary);
  assert.equal(db.prepare('SELECT an5_vector_version() v').get().v, 'an5-vector/1');

  for (const [metric, fn] of Object.entries(functions)) {
    const statement = db.prepare(`SELECT ${fn}(?, ?) d`);
    for (const dimension of [1, 2, 3, 7, 128, 1536]) {
      const a = encodeVector(Array.from({ length: dimension }, random));
      const b = encodeVector(Array.from({ length: dimension }, random));
      const expected = vectorDistance(decodeVector(a), decodeVector(b), metric);
      for (const left of [a, JSON.stringify(decodeVector(a))]) {
        for (const right of [b, JSON.stringify(decodeVector(b))]) closeTo(statement.get(left, right).d, expected);
      }
    }
    closeTo(statement.get(encodeVector([0, 0]), encodeVector([1, 0])).d, metric === 'cosine' ? 1 : metric === 'euclidean' ? 1 : 0);
    assert.equal(statement.get(encodeVector([1]), encodeVector([1, 2])).d, null);
    for (const invalid of [null, '', '[]', '[1,]', '[NaN]', '[Infinity]', '[01]', '[0x1]', '[true]', '[null]', '[1e400]', '[1]\u0000', '{}', Buffer.alloc(3)]) {
      assert.equal(statement.get(invalid, encodeVector([1])).d, null, `${fn}: ${JSON.stringify(invalid)}`);
    }
    const invalidFloat = Buffer.alloc(4);
    invalidFloat.writeFloatLE(Infinity);
    assert.equal(statement.get(invalidFloat, encodeVector([1])).d, null);
  }
  // Auxdata must track the query parameter and must never cache a varying column.
  db.exec('CREATE TABLE pairs(a BLOB, b BLOB)');
  const pair = db.prepare('INSERT INTO pairs VALUES (?, ?)');
  pair.run(encodeVector([1, 0]), encodeVector([1, 0]));
  pair.run(encodeVector([1, 0]), encodeVector([0, 1]));
  assert.deepEqual(db.prepare('SELECT an5_vec_cosine(a,b) d FROM pairs').all().map(r => r.d), [0, 1]);
  const parameter = db.prepare('SELECT an5_vec_cosine(a,?) d FROM pairs');
  assert.deepEqual(parameter.all(encodeVector([1, 0])).map(r => r.d), [0, 0]);
  assert.deepEqual(parameter.all(encodeVector([0, 1])).map(r => r.d), [1, 1]);

  const native = createAn5Adapter({ connectionString: ':memory:', sqliteVec: binary });
  const managed = createAn5Adapter({ connectionString: ':memory:' });
  for (const adapter of [native, managed]) {
    await adapter.exec('CREATE TABLE docs(id INTEGER PRIMARY KEY, embedding BLOB)');
    await adapter.exec('INSERT INTO docs VALUES(1,@v)', { v: encodeVector([1, 0]) });
    await adapter.exec('INSERT INTO docs VALUES(2,@v)', { v: '[0.8,0.2]' });
    await adapter.exec('INSERT INTO docs VALUES(3,@v)', { v: encodeVector([0, 1]) });
  }
  try {
    const support = await native.sqliteVectorSupport();
    assert.equal((await support.capabilities()).native, true);
    assert.equal((await native.exec('SELECT an5_vector_version() v'))[0].v, 'an5-vector/1');
    for (const metric of Object.keys(functions)) {
      const rows = await native.table('docs').vectorSearch({ vector: [1, 0], distanceMetric: metric, where: { id: { in: [1, 2] } }, take: 2 });
      assert.deepEqual(rows.map(r => r.id), [1, 2]);
    }
    // Invalid/non-finite rows are excluded by the native SQL functions.
    await native.exec('INSERT INTO docs VALUES(4,@v)', { v: '[NaN]' });
    assert.deepEqual((await native.table('docs').vectorSearch({ vector: [1, 0] })).map(r => r.id), [1, 2, 3]);
    console.log('SQLite native extension: codec, all metrics, malformed inputs, auxdata and public adapter passed');
    execFileSync(process.env.PYTHON || 'python3', ['test/python/sqlite_vector.py'], {
      cwd: root, env: { ...process.env, AN5_NATIVE_VECTOR_PATH: binary }, stdio: 'inherit',
    });
    if (process.argv.includes('--dotnet')) {
      execFileSync(process.execPath, ['scripts/dotnet-sqlite-smoke.js'], {
        cwd: root, env: { ...process.env, AN5_NATIVE_VECTOR_PATH: binary }, stdio: 'inherit',
      });
    }

    if (process.argv.includes('--benchmark')) {
      const count = 4000, dimensions = 256;
      const query = Array.from({ length: dimensions }, random);
      const rows = Array.from({ length: count }, (_, i) => ({ id: i, embedding: encodeVector(Array.from({ length: dimensions }, random)) }));
      for (const adapter of [native, managed]) {
        await adapter.exec('DELETE FROM docs');
        await adapter.$transaction(async tx => {
          for (const row of rows) await tx.exec('INSERT INTO docs VALUES(@id,@embedding)', row);
        });
      }
      for (const metric of Object.keys(functions)) {
        const args = { vector: query, distanceMetric: metric, take: 10 };
        const nativeRows = await native.table('docs').vectorSearch(args);
        const managedRows = await managed.table('docs').vectorSearch(args);
        assert.deepEqual(nativeRows.map(r => r.id), managedRows.map(r => r.id));
        const times = [];
        for (const adapter of [native, managed]) {
          for (let i = 0; i < 2; i++) await adapter.table('docs').vectorSearch(args);
          const samples = [];
          for (let i = 0; i < 7; i++) {
            const start = performance.now();
            await adapter.table('docs').vectorSearch(args);
            samples.push(performance.now() - start);
          }
          samples.sort((a,b) => a-b);
          times.push(samples[3]);
        }
        console.log(`${count} rows x ${dimensions} dimensions, ${metric}: native=${times[0].toFixed(2)}ms JS-UDF=${times[1].toFixed(2)}ms speedup=${(times[1]/times[0]).toFixed(1)}x (median of 7)`);
      }
    }
    await native.$disconnect();
    assert.equal((await (await native.sqliteVectorSupport()).capabilities()).native, true,
      'a reopened connection must reload the native extension');
  } finally {
    await native.$disconnect();
    await managed.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const db of buffers) db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
