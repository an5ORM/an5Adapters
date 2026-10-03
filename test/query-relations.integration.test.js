const assert = require('node:assert/strict');
const { createAn5Adapter, setAdapterMetadata } = require('../dist/index.js');
const { quote } = require('../dist/base/sql.js');
const targets = [
  { dialect: 'sqlite', connectionString: ':memory:' },
  ...['POSTGRES', 'MSSQL', 'MYSQL'].flatMap(name => process.env[`${name}_DATABASE_URL`]
    ? [{ dialect: name === 'POSTGRES' ? 'postgres' : name.toLowerCase(), connectionString: process.env[`${name}_DATABASE_URL`] }]
    : []),
];

async function run(target) {
  const db = createAn5Adapter(target);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const users = `an5_relation_users_${suffix}`, orders = `an5_relation_orders_${suffix}`;
  const q = name => quote(name, target.dialect);
  const relation = { modelName: 'Order', relationType: 'many', foreignKey: 'userId', localKey: 'id' };
  setAdapterMetadata({
    modelToTable: { User: users, Order: orders },
    relationMap: {
      User: { orders: relation, archived_orders: relation },
      Order: { user: { modelName: 'User', relationType: 'one', foreignKey: 'id', localKey: 'userId' } },
    },
  });
  try {
    await db.$connect();
    await db._executeRaw(`CREATE TABLE ${q(users)} (${q('id')} INTEGER PRIMARY KEY)`);
    await db._executeRaw(`CREATE TABLE ${q(orders)} (${q('id')} INTEGER PRIMARY KEY, ${q('userId')} INTEGER NULL, ${q('score')} INTEGER NULL)`);
    await db._executeRaw(`INSERT INTO ${q(users)} (${q('id')}) VALUES (1),(2),(3)`);
    await db._executeRaw(`INSERT INTO ${q(orders)} (${q('id')},${q('userId')},${q('score')}) VALUES (1,1,10),(2,1,20),(3,2,10),(4,NULL,NULL)`);
    const user = db.table('User'), order = db.table('Order');
    const ids = async (table, where) => (await table.findMany({ where, orderBy: { id: 'asc' } })).map(row => Number(row.id));
    assert.deepEqual(await ids(user, { orders: { some: { score: 10 }, none: { score: 20 } } }), [2]);
    assert.deepEqual(await ids(user, { orders: { some: { score: 10 } }, archived_orders: { some: { score: 20 } } }), [1]);
    assert.deepEqual(await ids(user, { orders: { every: { score: { gte: 10 } } } }), [1,2,3]);
    assert.deepEqual(await ids(order, { user: { is: null } }), [4]);
    assert.deepEqual(await ids(order, { user: { isNot: null } }), [1,2,3]);
    assert.deepEqual(await ids(order, { user: { is: { id: 2 } } }), [3]);
    assert.deepEqual(await ids(order, { user: { isNot: { id: 2 } } }), [1,2,4]);
    await assert.rejects(db.$transaction(async tx => {
      await tx.table('Order').updateMany({ where: { id: 4 }, data: { userId: 3 } });
      throw new Error('nullable relation rollback');
    }), /nullable relation rollback/);
    assert.deepEqual(await ids(order, { user: { is: null } }), [4]);
    console.log(`Query/relation contract passed: ${target.dialect}`);
  } finally {
    for (const table of [orders, users]) await db._executeRaw(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
    await db.$disconnect().catch(() => {});
  }
}
(async () => { for (const target of targets) await run(target); })().catch(error => { console.error(error); process.exitCode = 1; });
