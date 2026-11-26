const assert = require('node:assert/strict');
const { test: nodeTest } = require('node:test');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (error) {
  if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
}
const test = (name, fn) => nodeTest(name, { skip: !DatabaseSync && 'SQLite regression tests require Node.js 22.13+' }, fn);
const { parseWhere, buildHaving } = require('../dist/base/sql.js');
const { matchWhere, matchHaving } = require('../dist/googlesheets/helpers.js');
const { SheetsTableClient } = require('../dist/googlesheets/tableClient.js');

const rows = [{ id: 1, score: 0 }, { id: 2, score: 10 }, { id: 3, score: 20 }];
function query(where, ctx) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE users (id INTEGER, score INTEGER);
      INSERT INTO users VALUES (1, 0), (2, 10), (3, 20);
      CREATE TABLE posts (id INTEGER, userId INTEGER, score INTEGER);
      INSERT INTO posts VALUES (1, 1, 10), (2, 1, 20), (3, 2, 10);`);
    const params = {};
    const sql = parseWhere('User', where, params, 'sqlite', '', ctx);
    return db.prepare(`SELECT id FROM users${sql ? ` WHERE ${sql}` : ''} ORDER BY id`).all(params).map(row => row.id);
  } finally { db.close(); }
}
const relation = { modelName: 'Post', relationType: 'many', foreignKey: 'userId', localKey: 'id' };
const ctx = {
  modelToTable: { User: 'users', Post: 'posts' }, selfRef: '[users]',
  relationMap: { User: { posts: relation, other_posts: relation, profile: { ...relation, relationType: 'one' } } },
};

for (const [name, where, expected] of [
  ['empty OR matches no rows', { OR: [] }, []],
  ['OR containing an empty condition matches all rows', { OR: [{}, { id: 1 }] }, [1, 2, 3]],
  ['NOT an empty condition matches no rows', { NOT: {} }, []],
  ['empty NOT array matches all rows', { NOT: [] }, [1, 2, 3]],
  ['NOT array excludes each condition', { NOT: [{ score: 0 }, { score: 10 }] }, [3]],
  ['nested scalar NOT is supported', { score: { not: { gte: 10 } } }, [1]],
  ['AND object is supported', { AND: { score: { gte: 10 } } }, [2, 3]],
  ['undefined optional filters are omitted', { score: undefined }, [1, 2, 3]],
]) {
  test(name, () => {
    assert.deepEqual(query(where), expected);
    assert.deepEqual(rows.filter(row => matchWhere(row, where)).map(row => row.id), expected);
  });
}
test('underscored sheet fields preserve falsy filter operands', () => {
  for (const filter of [{ equals: 0 }, { gte: 0 }, { not: null }]) {
    assert.equal(matchWhere({ total_score: -1 }, { total_score: filter }), filter.not === null);
  }
});
test('relation quantifiers keep separate parameter values', () => {
  assert.deepEqual(query({ posts: { some: { score: 10 }, none: { score: 20 } } }, ctx), [2]);
});
test('two relations targeting the same model keep separate parameter values', () => {
  assert.deepEqual(query({ posts: { some: { score: 10 } }, other_posts: { some: { score: 20 } } }, ctx), [1]);
});
test('to-one null means absence and isNot null means presence', () => {
  assert.deepEqual(query({ profile: { is: null } }, ctx), [3]);
  assert.deepEqual(query({ profile: { isNot: null } }, ctx), [1, 2]);
});
test('nested self-relations correlate with the current parent alias', () => {
  const selfCtx = { modelToTable: { User: 'users' }, selfRef: '[users]', relationMap: {
    User: { peers: { modelName: 'User', relationType: 'many', foreignKey: 'score', localKey: 'score' } },
  } };
  assert.deepEqual(query({ peers: { some: { peers: { some: { id: 2 } } } } }, selfCtx), [2]);
});

test('empty string filters match empty cells consistently', () => {
  for (const operator of ['contains', 'startsWith', 'endsWith']) {
    assert.equal(matchWhere({ title: '' }, { title: { [operator]: '' } }), true);
    assert.equal(matchWhere({ title: null }, { title: { [operator]: '' } }), false);
  }
});

const contract = require('./fixtures/query-semantics.json');
for (const entry of contract.cases) {
  test(`shared contract: ${entry.name}`, () => {
    assert.deepEqual(query(entry.where), entry.ids);
    assert.deepEqual(contract.rows.filter(row => matchWhere(row, entry.where)).map(row => row.id), entry.ids);
  });
}

nodeTest('scalar and operator filters allocate distinct parameter names', () => {
  for (const dialect of ['mssql', 'postgres', 'mysql', 'sqlite']) {
    const params = {};
    const sql = parseWhere('User', { score: { equals: 10 }, score_eq: 20 }, params, dialect);
    assert.deepEqual(Object.values(params), [10, 20]);
    assert.match(sql, /@score_eq_1/);
  }
});

nodeTest('logical filters cannot overwrite scalar parameters', () => {
  const params = {};
  parseWhere('User', { AND: { id: 1 }, and_0_id: 2 }, params, 'sqlite');
  assert.deepEqual(Object.values(params), [1, 2]);
});

test('colliding filter names preserve SQL query results', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE items (score INTEGER, score_eq INTEGER); INSERT INTO items VALUES (10, 20), (20, 20)');
    const params = {};
    const sql = parseWhere('Item', { score: { equals: 10 }, score_eq: 20 }, params, 'sqlite');
    assert.deepEqual(db.prepare(`SELECT score FROM items WHERE ${sql}`).all(params).map(row => row.score), [10]);
  } finally { db.close(); }
});

nodeTest('nested NOT preserves parameters already bound by sibling filters', () => {
  const params = {};
  parseWhere('User', { score_not_score_eq: 20, score: { not: { equals: 10 } } }, params, 'sqlite');
  assert.deepEqual(Object.values(params), [20, 10]);
});

const { AdapterTableClient } = require('../dist/an5Adapter.js');
for (const [dialect, limit] of [['sqlite', '-1'], ['mysql', '18446744073709551615'], ['postgres', 'ALL']]) {
  nodeTest(`${dialect} supports offset-only pagination for rows and groups`, async () => {
    const queries = [];
    const table = new AdapterTableClient({ dialect, exec: async sql => { queries.push(sql); return []; } }, 'items');
    await table.findMany({ skip: 2, orderBy: { id: 'asc' } });
    await table.groupBy({ by: ['id'], skip: 2 });
    for (const sql of queries) assert.ok(sql.endsWith(`LIMIT ${limit} OFFSET 2`), sql);
    queries.length = 0;
    await table.findMany({ skip: 2, take: 3 });
    await table.groupBy({ by: ['id'], skip: 2, take: 3 });
    for (const sql of queries) assert.ok(sql.endsWith('LIMIT 3 OFFSET 2'), sql);
  });
}

test('SQLite offset-only pagination returns remaining rows and groups', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1), (2), (2), (3)');
    const table = new AdapterTableClient({ dialect: 'sqlite', exec: async (sql, params) => db.prepare(sql).all(params) }, 'items');
    assert.deepEqual((await table.findMany({ skip: 2, orderBy: { id: 'asc' } })).map(row => row.id), [2, 3]);
    assert.deepEqual((await table.groupBy({ by: ['id'], skip: 1 })).map(row => [row.id, row._count]), [[2, 2], [3, 1]]);
    assert.deepEqual(await table.findMany({ skip: 20 }), []);
    assert.deepEqual(await table.groupBy({ by: ['id'], skip: 20 }), []);
  } finally { db.close(); }
});


test('createMany preserves mixed columns and omitted database defaults', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'default', score INTEGER)");
    const table = new AdapterTableClient({
      dialect: 'sqlite',
      exec: async (sql, params) => {
        const stmt = db.prepare(sql);
        if (sql.startsWith('SELECT')) return stmt.all(params);
        stmt.run(params); return [];
      },
      _executeRaw: async (sql, params) => db.prepare(sql).run(params).changes,
    }, 'items');
    assert.deepEqual(await table.createMany({ data: [
      { id: 1, label: 'first' },
      { id: 2, score: 20 },
      { id: 3, label: undefined, score: 30 },
      { id: 4, label: null },
    ] }), { count: 4 });
    assert.deepEqual(db.prepare('SELECT * FROM items ORDER BY id').all().map(row => ({ ...row })), [
      { id: 1, label: 'first', score: null },
      { id: 2, label: 'default', score: 20 },
      { id: 3, label: 'default', score: 30 },
      { id: 4, label: null, score: null },
    ]);
  } finally { db.close(); }
});

nodeTest('createMany propagates bulk errors without retrying individual writes', async () => {
  const failure = new Error('database unavailable');
  let bulkCalls = 0, rowCalls = 0;
  const table = new AdapterTableClient({ dialect: 'sqlite',
    _executeRaw: async () => { bulkCalls++; throw failure; },
    exec: async () => { rowCalls++; return []; },
  }, 'items');
  await assert.rejects(table.createMany({ data: [{ id: 1 }, { id: 2 }] }), error => error === failure);
  assert.equal(bulkCalls, 1);
  assert.equal(rowCalls, 0);
});

nodeTest('createMany retains bulk insertion for identical column sets in different orders', async () => {
  let bulkCalls = 0;
  const table = new AdapterTableClient({ dialect: 'sqlite',
    _executeRaw: async () => { bulkCalls++; return 2; },
    exec: async () => { throw new Error('unexpected individual insertion'); },
  }, 'items');
  assert.deepEqual(await table.createMany({ data: [{ id: 1, score: 10 }, { score: 20, id: 2 }] }), { count: 2 });
  assert.equal(bulkCalls, 1);
});

test('failed homogeneous createMany does not insert a partial retry', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY); INSERT INTO items VALUES (2)');
    const table = new AdapterTableClient({ dialect: 'sqlite',
      _executeRaw: async (sql, params) => db.prepare(sql).run(params).changes,
      exec: async (sql, params) => {
        const stmt = db.prepare(sql);
        if (sql.startsWith('SELECT')) return stmt.all(params);
        stmt.run(params); return [];
      },
    }, 'items');
    await assert.rejects(table.createMany({ data: [{ id: 1 }, { id: 2 }] }), /UNIQUE constraint/);
    assert.deepEqual(db.prepare('SELECT id FROM items').all().map(row => row.id), [2]);
  } finally { db.close(); }
});


for (const [dialect, duplicate, other] of [
  ['postgres', { code: '23505' }, { code: '23503' }],
  ['mysql', { code: 'ER_DUP_ENTRY', errno: 1062 }, { code: 'ER_BAD_NULL_ERROR', errno: 1048 }],
  ['sqlite', { code: 'SQLITE_CONSTRAINT_UNIQUE' }, { code: 'SQLITE_CONSTRAINT_NOTNULL' }],
  ['sqlite', { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }, { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }],
  ['sqlite', { code: 'ERR_SQLITE_ERROR', errcode: 2067 }, { code: 'ERR_SQLITE_ERROR', errcode: 1299 }],
  ['sqlite', { code: 'ERR_SQLITE_ERROR', errcode: 1555 }, { code: 'ERR_SQLITE_ERROR', errcode: 787 }],
  ['mssql', { number: 2627 }, { number: 547 }],
  ['mssql', { originalError: { info: { number: 2601 } } }, { number: 515 }],
]) {
  nodeTest(`skipDuplicates only ignores unique violations: ${dialect} ${JSON.stringify(duplicate)}`, async () => {
    const table = new AdapterTableClient({ dialect }, 'items');
    let calls = 0;
    table.create = async () => { if (++calls === 1) throw duplicate; return { id: 2 }; };
    assert.deepEqual(await table.createMany({ data: [{ id: 1 }, { id: 2 }], skipDuplicates: true }), { count: 1 });
    table.create = async () => { throw other; };
    await assert.rejects(table.createMany({ data: [{ id: 1 }], skipDuplicates: true }), error => error === other);
    table.create = async () => { throw duplicate; };
    await assert.rejects(table.createMany({ data: [{}] }), error => error === duplicate);
  });
}

nodeTest('skipDuplicates propagates connection errors even with a duplicate-looking message', async () => {
  const error = Object.assign(new Error('duplicate key: connection unavailable'), { code: 'ECONNRESET' });
  const table = new AdapterTableClient({ dialect: 'postgres' }, 'items');
  table.create = async () => { throw error; };
  await assert.rejects(table.createMany({ data: [{ id: 1 }], skipDuplicates: true }), e => e === error);
});

test('SQLite skipDuplicates skips duplicates and propagates NOT NULL violations', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE); INSERT INTO items VALUES (1, 'first')");
    const table = new AdapterTableClient({ dialect: 'sqlite', exec: async (sql, params) => {
      const stmt = db.prepare(sql);
      if (sql.startsWith('SELECT')) return stmt.all(params);
      stmt.run(params); return [];
    } }, 'items');
    assert.deepEqual(await table.createMany({ data: [
      { id: 1, label: 'other' }, { id: 2, label: 'first' }, { id: 3, label: 'third' },
    ], skipDuplicates: true }), { count: 1 });
    await assert.rejects(table.createMany({ data: [{ id: 4, label: null }], skipDuplicates: true }), /NOT NULL/);
    assert.deepEqual(db.prepare('SELECT id FROM items ORDER BY id').all().map(row => row.id), [1, 3]);
  } finally { db.close(); }
});


nodeTest('Sheets createMany propagates append failures without retrying individual rows', async () => {
  const { SheetsTableClient } = require('../dist/googlesheets/tableClient.js');
  const failure = new Error('append request timed out');
  let appends = 0;
  const table = new SheetsTableClient({ appendRange: async () => { appends++; throw failure; } }, 'items');
  table.getOrCreateHeaders = async () => ['id'];
  table.create = async () => { throw new Error('unexpected individual retry'); };
  await assert.rejects(table.createMany({ data: [{ id: 1 }, { id: 2 }], skipDuplicates: true }), e => e === failure);
  assert.equal(appends, 1);
});

nodeTest('primary-key resolution prefers explicit metadata over id-like names', () => {
  const { resolveIdField } = require('../dist/base/metadata.js');
  assert.equal(resolveIdField({ ownerId: { ts: 'string' }, id: { ts: 'string' }, key: { ts: 'string', isId: true } }), 'key');
  assert.equal(resolveIdField({ id: 'string', ownerId: 'string' }), 'id');
  assert.equal(resolveIdField({ ownerId: 'string' }), 'ownerId');
  assert.equal(resolveIdField({ label: 'string' }), undefined);
});

test('create generates the custom primary key and preserves the foreign key', async () => {
  const { setAdapterMetadata } = require('../dist/base/metadata.js');
  const db = new DatabaseSync(':memory:');
  setAdapterMetadata({ modelFields: { items: {
    ownerId: { ts: 'string' }, key: { ts: 'string', isId: true }, label: { ts: 'string' },
  } } });
  try {
    db.exec('CREATE TABLE items (key TEXT PRIMARY KEY NOT NULL, ownerId TEXT, label TEXT)');
    const table = new AdapterTableClient({ dialect: 'sqlite', exec: async (sql, params) => {
      const stmt = db.prepare(sql);
      if (sql.startsWith('SELECT')) return stmt.all(params);
      stmt.run(params); return [];
    } }, 'items');
    const first = await table.create({ data: { ownerId: 'owner', label: 'first' } });
    const second = await table.create({ data: { ownerId: 'owner', label: 'second' } });
    assert.match(first.key, /^[0-9a-f-]{36}$/i);
    assert.notEqual(second.key, first.key);
    assert.equal(second.label, 'second');
    assert.equal(second.ownerId, 'owner');
    assert.deepEqual(await table.createMany({ data: [
      { ownerId: 'owner', label: 'bulk-first' }, { ownerId: 'owner', label: 'bulk-second' },
    ] }), { count: 2 });
    const keys = db.prepare('SELECT key FROM items').all().map(row => row.key);
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, 4);
    for (const key of keys) assert.match(key, /^[0-9a-f-]{36}$/i);
  } finally { db.close(); setAdapterMetadata({}); }
});

nodeTest('Sheets create and createMany assign schema primary keys rather than foreign keys', async () => {
  const { setAdapterMetadata } = require('../dist/base/metadata.js');
  const { SheetsTableClient } = require('../dist/googlesheets/tableClient.js');
  setAdapterMetadata({ modelFields: { items: { ownerId: { ts: 'string' }, key: { ts: 'string', isId: true } } } });
  const appended = [];
  try {
    const table = new SheetsTableClient({ appendRange: async (range, rows) => { appended.push(...rows); } }, 'items');
    table.getOrCreateHeaders = async () => ['ownerId', 'key'];
    const created = await table.create({ data: { ownerId: 'owner' } });
    assert.match(created.key, /^[0-9a-f-]{36}$/i);
    await table.createMany({ data: [{ ownerId: 'owner' }, { ownerId: 'owner', key: 'explicit' }] });
    assert.equal(appended.length, 3);
    assert.equal(appended[1][0], 'owner');
    assert.match(appended[1][1], /^[0-9a-f-]{36}$/i);
    assert.deepEqual(appended[2], ['owner', 'explicit']);
  } finally { setAdapterMetadata({}); }
});


for (const [operation, suffix, operand, expected] of [
  ['increment', 'inc', 2, 12], ['decrement', 'dec', 2, 8],
  ['multiply', 'mul', 3, 30], ['divide', 'div', 2, 5], ['set', 'set', 7, 7],
]) {
  test(`updateMany keeps ${operation} operands separate from similarly named fields`, async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE items (id INTEGER, score INTEGER, score_${suffix} INTEGER); INSERT INTO items VALUES (1, 10, 0), (2, 20, 0)`);
      const table = new AdapterTableClient({ dialect: 'sqlite',
        _executeRaw: async (sql, params) => db.prepare(sql).run(params).changes,
      }, 'items');
      for (const reverse of [false, true]) {
        db.exec(`UPDATE items SET score = 10, score_${suffix} = 0 WHERE id = 1`);
        const entries = [['score', { [operation]: operand }], [`score_${suffix}`, 100]];
        const data = Object.fromEntries(reverse ? entries.reverse() : entries);
        assert.deepEqual(await table.updateMany({ where: { id: 1 }, data }), { count: 1 });
        const row = db.prepare('SELECT * FROM items WHERE id = 1').get();
        assert.equal(row.score, expected);
        assert.equal(row[`score_${suffix}`], 100);
      }
      assert.equal(db.prepare('SELECT score FROM items WHERE id = 2').get().score, 20);
    } finally { db.close(); }
  });
}

test('update keeps distinct values when field names sanitize to the same parameter name', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, "a-b" INTEGER, a_b INTEGER); INSERT INTO items VALUES (1, 0, 0)');
    const table = new AdapterTableClient({ dialect: 'sqlite',
      exec: async (sql, params) => db.prepare(sql).all(params),
      _executeRaw: async (sql, params) => db.prepare(sql).run(params).changes,
    }, 'items');
    const row = await table.update({ where: { id: 1 }, data: { 'a-b': 10, a_b: 20 }, select: { 'a-b': true, a_b: true } });
    assert.deepEqual(row, { 'a-b': 10, a_b: 20 });
  } finally { db.close(); }
});

for (const dialect of ['sqlite', 'postgres', 'mysql', 'mssql']) {
  nodeTest(`${dialect} update parameters preserve filter and assignment values`, async () => {
    const table = new AdapterTableClient({ dialect,
      _executeRaw: async (sql, params) => {
        assert.deepEqual(Object.values(params), [1, 2, 100, 10, 20]);
        const names = [...sql.matchAll(/@(\w+)/g)].map(match => match[1]);
        assert.equal(new Set(names).size, 5);
        for (const name of names) assert.ok(Object.hasOwn(params, name));
        return 1;
      },
    }, 'items');
    assert.deepEqual(await table.updateMany({ where: { id: 1 }, data: {
      score: { increment: 2 }, score_inc: 100, 'a-b': 10, a_b: 20,
    } }), { count: 1 });
  });
}

nodeTest('parseWhere rejects malformed clauses, unknown operators, and unknown fields', () => {
  const fieldsCtx = {
    ...ctx,
    modelFields: {
      User: { id: { ts: 'number' }, score: { ts: 'number' }, total_score: { ts: 'number' } },
      Post: { id: { ts: 'number' }, userId: { ts: 'number' }, score: { ts: 'number' } },
    },
  };
  assert.throws(() => parseWhere('User', 'bad', {}, 'sqlite'), /plain object/);
  assert.throws(() => parseWhere('User', ['bad'], {}, 'sqlite'), /plain object/);
  assert.throws(() => parseWhere('User', { OR: { id: 1 } }, {}, 'sqlite'), /OR filter must be an array/);
  assert.throws(() => parseWhere('User', { OR: ['bad'] }, {}, 'sqlite'), /OR filter entries/);
  assert.throws(() => parseWhere('User', { AND: 'bad' }, {}, 'sqlite'), /AND filter/);
  assert.throws(() => parseWhere('User', { NOT: 123 }, {}, 'sqlite'), /NOT filter/);
  assert.throws(() => parseWhere('User', { score: [1, 2] }, {}, 'sqlite'), /use \{ in:/);
  assert.throws(() => parseWhere('User', { score: { bogus: 1 } }, {}, 'sqlite', '', fieldsCtx), /Unknown filter operator 'bogus'/);
  assert.throws(() => parseWhere('User', { score: { some: {} } }, {}, 'sqlite', '', fieldsCtx), /Relation filter operator 'some' cannot be used on scalar field 'score'/);
  assert.throws(() => parseWhere('User', { score: { is: null } }, {}, 'sqlite', '', fieldsCtx), /Relation filter operator 'is' cannot be used on scalar field 'score'/);
  assert.throws(() => parseWhere('User', { score: { contains: 'a', mode: 'fuzzy' } }, {}, 'sqlite'), /Invalid filter mode 'fuzzy'/);
  assert.throws(() => parseWhere('User', { score: { in: 10 } }, {}, 'sqlite'), /must be an array/);
  assert.throws(() => parseWhere('User', { score: { notIn: 'x' } }, {}, 'sqlite'), /must be an array/);
  assert.throws(() => parseWhere('User', { score: { contains: 123 } }, {}, 'sqlite'), /must be a string/);
  assert.throws(() => parseWhere('User', { score: { not: [1, 2] } }, {}, 'sqlite'), /use 'notIn' instead/);
  assert.throws(() => parseWhere('User', { posts: { is: { score: 10 } } }, {}, 'sqlite', '', fieldsCtx), /Unsupported relation filter operator 'is'/);
  assert.throws(() => parseWhere('User', { posts: { bogus: {} } }, {}, 'sqlite', '', fieldsCtx), /Unsupported relation filter operator 'bogus'/);
  assert.throws(() => parseWhere('User', { posts: { some: null } }, {}, 'sqlite', '', fieldsCtx), /must be a plain object/);
  assert.throws(() => parseWhere('User', { posts: 'bad' }, {}, 'sqlite', '', fieldsCtx), /must be a plain object/);
  assert.throws(() => parseWhere('User', { profile: { some: { score: 10 } } }, {}, 'sqlite', '', fieldsCtx), /Unsupported relation filter operator 'some'/);
  assert.throws(() => parseWhere('User', { profile: { bogus: {} } }, {}, 'sqlite', '', fieldsCtx), /Unsupported relation filter operator 'bogus'/);
  assert.throws(() => parseWhere('User', { profile: { is: 'bad' } }, {}, 'sqlite', '', fieldsCtx), /plain object or null/);
  assert.throws(() => parseWhere('User', { profile: { isNot: null, is_not: null } }, {}, 'sqlite', '', fieldsCtx), /Duplicate relation filter operator/);
  assert.throws(() => parseWhere('User', { missingCol: 1 }, {}, 'sqlite', '', fieldsCtx), /Unknown field 'missingCol'/);
  // Undocumented underscored fields must not flatten bogus operators into compound keys.
  assert.throws(() => parseWhere('User', { total_score: { bogus: 1 } }, {}, 'sqlite', '', fieldsCtx), /Unknown filter operator 'bogus' on field 'total_score'/);
  assert.throws(() => parseWhere('User', { total_score: { bogus: 1 } }, {}, 'sqlite'), /Unknown filter operator 'bogus' on field 'total_score'/);
  assert.throws(() => parseWhere('User', { other_posts: { is: {} } }, {}, 'sqlite', '', fieldsCtx), /Unsupported relation filter operator 'is'/);
});

test('parseWhere supports mode insensitive across operators on SQLite and ILIKE on Postgres', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE names (id INTEGER, email TEXT);
      INSERT INTO names VALUES (1, 'Alice@Example.com'), (2, 'bob@example.com'), (3, NULL);`);
    const q = (where) => {
      const params = {};
      const sql = parseWhere('Name', where, params, 'sqlite');
      return db.prepare(`SELECT id FROM names${sql ? ` WHERE ${sql}` : ''} ORDER BY id`).all(params).map(r => r.id);
    };
    assert.deepEqual(q({ email: { equals: 'alice@example.com', mode: 'insensitive' } }), [1]);
    assert.deepEqual(q({ email: { contains: 'ALICE', mode: 'insensitive' } }), [1]);
    assert.deepEqual(q({ email: { startsWith: 'BOB', mode: 'insensitive' } }), [2]);
    assert.deepEqual(q({ email: { endsWith: 'EXAMPLE.COM', mode: 'insensitive' } }), [1, 2]);
    assert.deepEqual(q({ email: { not: 'alice@example.com', mode: 'insensitive' } }), [2]);
    assert.deepEqual(q({ email: { in: ['ALICE@EXAMPLE.COM'], mode: 'insensitive' } }), [1]);
    assert.deepEqual(q({ email: { notIn: ['BOB@EXAMPLE.COM'], mode: 'insensitive' } }), [1]);
  } finally { db.close(); }

  const pgParams = {};
  const pgSql = parseWhere('Name', { email: { contains: 'Alice', mode: 'insensitive' } }, pgParams, 'postgres');
  assert.match(pgSql, /ILIKE/);
  assert.equal(pgParams.email_co, '%Alice%');
});

test('parseWhere supports is_not alias and distinct per-operator aliases on the same relation', () => {
  assert.deepEqual(query({ profile: { is_not: null } }, ctx), [1, 2]);
  assert.deepEqual(query({ profile: { is_not: { score: 20 } } }, ctx), [2, 3]);
  assert.deepEqual(query({ posts: { some: { score: 10 }, every: { score: { gte: 10 } } } }, ctx), [1, 2]);
  assert.deepEqual(query({ profile: { is: { score: 10 }, isNot: { id: 999 } } }, ctx), [1, 2]);
});

nodeTest('Google Sheets matchWhere rejects malformed filters and supports mode insensitive cleanly', () => {
  const sample = [{ id: 1, title: 'Alice', total_score: 5 }, { id: 2, title: '', total_score: 10 }, { id: 3, title: null, total_score: 0 }];
  assert.throws(() => matchWhere(sample[0], 'bad'), /plain object/);
  assert.throws(() => matchWhere(sample[0], { OR: { id: 1 } }), /OR filter must be an array/);
  assert.throws(() => matchWhere(sample[0], { AND: 'bad' }), /AND filter/);
  assert.throws(() => matchWhere(sample[0], { NOT: 1 }), /NOT filter/);
  assert.throws(() => matchWhere(sample[0], { title: ['a'] }), /use \{ in:/);
  assert.throws(() => matchWhere(sample[0], { title: { bogus: 'x' } }), /Unknown filter operator 'bogus'/);
  assert.throws(() => matchWhere(sample[0], { total_score: { bogus: 1 } }), /Unknown filter operator 'bogus' on field 'total_score'/);
  assert.throws(() => matchWhere(sample[0], { title: { some: {} } }), /Relation filter operator 'some'/);
  assert.throws(() => matchWhere(sample[0], { title: { contains: 'a', mode: 'fuzzy' } }), /Invalid filter mode 'fuzzy'/);
  assert.throws(() => matchWhere(sample[0], { title: { in: 'a' } }), /must be an array/);
  assert.throws(() => matchWhere(sample[0], { title: { notIn: 'a' } }), /must be an array/);
  assert.throws(() => matchWhere(sample[0], { title: { contains: 1 } }), /must be a string/);
  assert.throws(() => matchWhere(sample[0], { title: { not: ['a'] } }), /use 'notIn' instead/);

  assert.deepEqual(sample.filter(r => matchWhere(r, { title: { equals: null, mode: 'insensitive' } })).map(r => r.id), [3]);
  assert.deepEqual(sample.filter(r => matchWhere(r, { title: { equals: 'ALICE', mode: 'insensitive' } })).map(r => r.id), [1]);
  assert.deepEqual(sample.filter(r => matchWhere(r, { title: { in: ['alice'], mode: 'insensitive' } })).map(r => r.id), [1]);
});

test('groupBy supports having aggregate and grouped scalar filters on SQLite plus per-field _count', async () => {
  const { setAdapterMetadata } = require('../dist/base/metadata.js');
  const db = new DatabaseSync(':memory:');
  setAdapterMetadata({
    modelToTable: { Order: 'orders' },
    modelFields: {
      Order: {
        id: { ts: 'number', isId: true },
        status: { ts: 'string' },
        total: { ts: 'number' },
        note: { ts: 'string?' },
      },
    },
  });
  try {
    db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, total INTEGER, note TEXT NULL);
      INSERT INTO orders VALUES
        (1, 'Paid', 100, 'vip'),
        (2, 'Paid', 200, NULL),
        (3, 'Open', 50, 'hold'),
        (4, 'Open', 60, 'hold'),
        (5, 'Void', 10, NULL);`);
    const table = new AdapterTableClient({ dialect: 'sqlite', exec: async (sql, params) => db.prepare(sql).all(params) }, 'Order');

    const byTotal = await table.groupBy({
      by: 'status',
      _count: { _all: true, note: true },
      _sum: { total: true },
      _avg: { total: true },
      _min: { total: true },
      _max: { total: true },
      having: { _sum: { total: { gte: 110 } }, _count: { note: { gte: 1 } } },
      orderBy: { status: 'asc' },
    });
    assert.deepEqual(byTotal.map(r => ({
      status: r.status,
      all: r._count._all,
      note: r._count.note,
      sum: r._sum.total,
      avg: r._avg.total,
      min: r._min.total,
      max: r._max.total,
    })), [
      { status: 'Open', all: 2, note: 2, sum: 110, avg: 55, min: 50, max: 60 },
      { status: 'Paid', all: 2, note: 1, sum: 300, avg: 150, min: 100, max: 200 },
    ]);

    const combinedHaving = await table.groupBy({
      by: ['status'],
      where: { total: { gte: 10 } },
      _count: true,
      having: {
        OR: [
          { status: { equals: 'void', mode: 'insensitive' } },
          { AND: [{ _avg: { total: { gt: 100 } } }, { NOT: { _min: { total: { lt: 50 } } } }] },
        ],
      },
      orderBy: { status: 'asc' },
    });
    assert.deepEqual(combinedHaving.map(r => [r.status, r._count]), [['Paid', 2], ['Void', 1]]);

    await assert.rejects(() => table.groupBy({ by: ['status'], having: { total: { gt: 10 } } }), /must be included in groupBy/);
    await assert.rejects(() => table.groupBy({ by: ['status'], having: { _sum: { _all: 1 } } }), /does not support '_all'/);
    await assert.rejects(() => table.groupBy({ by: ['status'], having: { _unknown: { total: 1 } } }), /Unknown having aggregate key/);
    await assert.rejects(() => table.groupBy({ by: ['status'], having: { _sum: { missingCol: 1 } } }), /Unknown field 'missingCol'/);
    await assert.rejects(() => table.groupBy({ by: ['status'], having: { _sum: { total: { bogus: 1 } } } }), /Unknown filter operator 'bogus'/);
    await assert.rejects(() => table.groupBy({ by: ['status'], having: { _sum: { total: { some: {} } } } }), /Relation filter operator 'some'/);
  } finally {
    setAdapterMetadata({});
    db.close();
  }
});

nodeTest('buildHaving quotes aggregate expressions per SQL dialect and rejects malformed clauses', () => {
  for (const [dialect, expected] of [
    ['postgres', 'SUM("total") >= @having__sum_total_gte'],
    ['mysql', 'SUM(`total`) >= @having__sum_total_gte'],
    ['mssql', 'SUM([total]) >= @having__sum_total_gte'],
    ['sqlite', 'SUM([total]) >= @having__sum_total_gte'],
  ]) {
    const params = {};
    const sql = buildHaving({ _sum: { total: { gte: 100 } }, _count: { _all: { not: { lt: 2 } } } }, params, dialect, ['status']);
    assert.ok(sql.includes(expected), sql);
    assert.ok(sql.includes('NOT (COUNT(*) < @having__count__all_not_lt)'), sql);
  }
  assert.throws(() => buildHaving('bad', {}, 'sqlite', ['status']), /plain object/);
  assert.throws(() => buildHaving({ OR: { _count: { _all: 1 } } }, {}, 'sqlite', ['status']), /OR filter must be an array/);
  assert.throws(() => buildHaving({ _sum: 'bad' }, {}, 'sqlite', ['status']), /plain object/);
  assert.equal(matchHaving([{ status: 'paid', total: 100 }], ['status'], { _sum: { total: { gte: 100 } } }), true);
});

nodeTest('SheetsTableClient.groupBy supports aggregates, having filters, ordering, and pagination', async () => {
  const sheetRows = [
    ['id', 'status', 'total', 'note'],
    ['1', 'a|b', '100', 'vip'],
    ['2', 'a|b', '200', ''],
    ['3', 'open', '40', 'hold'],
    ['4', 'void', '5', ''],
  ];
  const fakeAdapter = {
    config: { spreadsheetId: 'sheet-1' },
    getSheets: async () => ({
      spreadsheets: { values: { get: async () => ({ data: { values: sheetRows } }) } },
    }),
  };
  const client = new SheetsTableClient(fakeAdapter, 'Order');
  const rows = await client.groupBy({
    by: 'status',
    _count: { _all: true, note: true },
    _sum: { total: true },
    _avg: { total: true },
    _min: { total: true },
    _max: { total: true },
    having: { _sum: { total: { gte: 40 } } },
    orderBy: { status: 'asc' },
    skip: 0,
    take: 5,
  });
  assert.deepEqual(rows, [
    {
      status: 'a|b',
      _count: { _all: 2, note: 1 },
      _sum: { total: 300 },
      _avg: { total: 150 },
      _min: { total: 100 },
      _max: { total: 200 },
    },
    {
      status: 'open',
      _count: { _all: 1, note: 1 },
      _sum: { total: 40 },
      _avg: { total: 40 },
      _min: { total: 40 },
      _max: { total: 40 },
    },
  ]);

  const emptyGroupHaving = await client.groupBy({
    by: 'status',
    having: { OR: [] },
  });
  assert.deepEqual(emptyGroupHaving, []);

  await assert.rejects(() => client.groupBy({ by: 'status', having: { total: { gt: 10 } } }), /must be included in groupBy/);
  await assert.rejects(() => client.groupBy({ by: [] }), /groupBy requires 'by' fields/);
});
