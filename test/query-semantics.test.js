const assert = require('node:assert/strict');
const { test: nodeTest } = require('node:test');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (error) {
  if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
}
const test = (name, fn) => nodeTest(name, { skip: !DatabaseSync && 'SQLite regression tests require Node.js 22.13+' }, fn);
const { parseWhere } = require('../dist/base/sql.js');
const { matchWhere } = require('../dist/googlesheets/helpers.js');

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
