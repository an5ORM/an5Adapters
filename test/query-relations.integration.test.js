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
    const groups = await user.groupBy({
      by: ['id'], where: { orders: { some: { score: 10 }, none: { score: 20 } } }, orderBy: { id: 'asc' },
    });
    assert.deepEqual(groups.map(row => [Number(row.id), Number(row._count)]), [[2, 1]]);
    const absentGroups = await order.groupBy({ by: ['id'], where: { user: { is: null } } });
    assert.deepEqual(absentGroups.map(row => Number(row.id)), [4]);
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

async function runGeneratedMetadataOrientationSuite() {
  const db = createAn5Adapter({ dialect: 'sqlite', connectionString: ':memory:' });
  setAdapterMetadata({
    modelToTable: { User: 'users', Order: 'orders', Profile: 'profiles' },
    modelFields: {
      User: { id: { ts: 'number', isId: true }, name: { ts: 'string' } },
      Order: { id: { ts: 'number', isId: true }, userId: { ts: 'number' }, status: { ts: 'string' } },
      Profile: { id: { ts: 'number', isId: true }, userId: { ts: 'number' }, bio: { ts: 'string' } },
    },
    relationMap: {
      User: {
        orders: { modelName: 'Order', relationType: 'many', foreignKey: 'userId', localKey: 'id' },
        profile: { modelName: 'Profile', relationType: 'one', foreignKey: 'userId', localKey: 'id' },
      },
      Order: {
        user: { modelName: 'User', relationType: 'one', foreignKey: 'userId', localKey: 'id' },
      },
      Profile: {
        user: { modelName: 'User', relationType: 'one', foreignKey: 'userId', localKey: 'id' },
      },
    },
  });
  try {
    await db.$connect();
    await db._executeRaw('CREATE TABLE [users] ([id] INTEGER PRIMARY KEY, [name] TEXT NOT NULL)');
    await db._executeRaw('CREATE TABLE [orders] ([id] INTEGER PRIMARY KEY, [userId] INTEGER NULL, [status] TEXT NOT NULL)');
    await db._executeRaw('CREATE TABLE [profiles] ([id] INTEGER PRIMARY KEY, [userId] INTEGER NOT NULL, [bio] TEXT NOT NULL)');
    await db._executeRaw("INSERT INTO [users] ([id], [name]) VALUES (1, 'Alice'), (2, 'Bob')");
    await db._executeRaw("INSERT INTO [orders] ([id], [userId], [status]) VALUES (10, 1, 'paid'), (20, 2, 'open'), (30, NULL, 'orphan')");
    await db._executeRaw("INSERT INTO [profiles] ([id], [userId], [bio]) VALUES (100, 1, 'Systems Engineer')");

    const user = db.table('User');
    const order = db.table('Order');

    // FK-holding to-one filter + include (Order.user with foreignKey='userId', localKey='id')
    const aliceOrders = await order.findMany({ where: { user: { is: { name: 'Alice' } } }, include: { user: true }, orderBy: { id: 'asc' } });
    assert.deepEqual(aliceOrders.map(o => o.id), [10]);
    assert.equal(aliceOrders[0].user.name, 'Alice');

    const notAliceOrders = await order.findMany({ where: { user: { isNot: { name: 'Alice' } } }, orderBy: { id: 'asc' } });
    assert.deepEqual(notAliceOrders.map(o => o.id), [20, 30]);

    const presentOrders = await order.findMany({ where: { user: { is_not: null } }, orderBy: { id: 'asc' } });
    assert.deepEqual(presentOrders.map(o => o.id), [10, 20]);

    // Inverse 1-to-1 filter + include (User.profile with foreignKey='userId' on Profile, localKey='id' on User)
    const usersWithProfile = await user.findMany({
      where: { profile: { is: { bio: { contains: 'ENG', mode: 'insensitive' } } } },
      include: { profile: true },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(usersWithProfile.map(u => u.id), [1]);
    assert.equal(usersWithProfile[0].profile.bio, 'Systems Engineer');

    const usersWithoutProfile = await user.findMany({ where: { profile: { is: null } }, orderBy: { id: 'asc' } });
    assert.deepEqual(usersWithoutProfile.map(u => u.id), [2]);

    const usersSomeAndEvery = await user.findMany({
      where: { orders: { some: { status: 'paid' }, every: { status: { not: 'cancelled' } } } },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(usersSomeAndEvery.map(u => u.id), [1]);

    // Strict validation propagates through TableClient
    await assert.rejects(() => user.findMany({ where: { bogusField: 'x' } }), /Unknown field 'bogusField'/);
    await assert.rejects(() => user.findMany({ where: { name: { bogusOp: 'x' } } }), /Unknown filter operator 'bogusOp'/);
    await assert.rejects(() => user.findMany({ where: { orders: { is: {} } } }), /Unsupported relation filter operator 'is'/);
    console.log('Generated metadata relation orientation & strict validation suite passed');
  } finally {
    setAdapterMetadata({});
    await db.$disconnect().catch(() => {});
  }
}
// A missing optional driver must not fail the run: the publish jobs depend on this
// one, so an absent SQLite driver used to turn a release into a silent skip — the
// version was tagged, the PyPI and GitHub Release jobs never ran, and nothing
// failed where anyone was looking.
const MISSING_DRIVER = /better-sqlite3 package is required/;

(async () => {
  for (const target of targets) {
    try {
      await run(target);
    } catch (error) {
      if (target.dialect === 'sqlite' && MISSING_DRIVER.test(error.message)) {
        console.log(`Query/relation contract skipped for sqlite: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
  try {
    await runGeneratedMetadataOrientationSuite();
  } catch (error) {
    if (!MISSING_DRIVER.test(error.message)) throw error;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
