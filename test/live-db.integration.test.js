const assert = require('assert');
const { createAn5Adapter, setAdapterMetadata } = require('../dist/index.js');

const POSTGRES_URL = process.env.POSTGRES_DATABASE_URL;
const MSSQL_URL = process.env.MSSQL_DATABASE_URL;
const REQUIRE_LIVE_DB = process.env.REQUIRE_LIVE_DB === '1';

const targets = [
  POSTGRES_URL && { dialect: 'postgres', connectionString: POSTGRES_URL },
  MSSQL_URL && { dialect: 'mssql', connectionString: MSSQL_URL },
].filter(Boolean);

function quoteIdent(name, dialect) {
  return dialect === 'postgres' ? `"${name.replace(/"/g, '""')}"` : `[${name.replace(/]/g, ']]')}]`;
}

function paramCast(dialect, paramName, type) {
  if (dialect !== 'postgres') return `@${paramName}`;
  if (type === 'int') return `@${paramName}::integer`;
  return `@${paramName}::text`;
}

function createTableSql(table, dialect) {
  const t = quoteIdent(table, dialect);
  if (dialect === 'postgres') {
    return [
      `CREATE TABLE ${t} (`,
      `"id" TEXT PRIMARY KEY,`,
      `"name" TEXT NOT NULL,`,
      `"category" TEXT NULL,`,
      `"score" INTEGER NOT NULL DEFAULT 0,`,
      `"embedding" TEXT NULL`,
      `)`
    ].join(' ');
  }

  return [
    `CREATE TABLE ${t} (`,
    `[id] NVARCHAR(64) NOT NULL PRIMARY KEY,`,
    `[name] NVARCHAR(255) NOT NULL,`,
    `[category] NVARCHAR(255) NULL,`,
    `[score] INT NOT NULL DEFAULT 0,`,
    `[embedding] NVARCHAR(MAX) NULL`,
    `)`
  ].join(' ');
}

async function waitForConnection(adapter, label) {
  let lastError;
  for (let i = 0; i < 40; i++) {
    try {
      await adapter.$connect();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || lastError}`);
}

async function runDialect(target) {
  const { dialect, connectionString } = target;
  const tableName = `an5_live_items_${dialect}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  const quotedTable = quoteIdent(tableName, dialect);
  const adapter = createAn5Adapter({ connectionString, connectionTimeout: 30000, requestTimeout: 60000 });
  const table = adapter.table('liveItem');

  setAdapterMetadata({
    modelToTable: {
      liveItem: tableName,
      LiveItem: tableName,
      liveItems: tableName,
      LiveItems: tableName,
    },
    modelFields: {
      liveItem: {
        id: { ts: 'string', sql: dialect === 'postgres' ? 'TEXT' : 'NVARCHAR(64)' },
        name: { ts: 'string', sql: dialect === 'postgres' ? 'TEXT' : 'NVARCHAR(255)' },
        category: { ts: 'string', sql: dialect === 'postgres' ? 'TEXT' : 'NVARCHAR(255)' },
        score: { ts: 'number', sql: 'INT' },
        embedding: { ts: 'string', sql: dialect === 'postgres' ? 'TEXT' : 'NVARCHAR(MAX)' },
      },
    },
  });

  try {
    await waitForConnection(adapter, dialect);
    await adapter._executeRaw(`DROP TABLE IF EXISTS ${quotedTable}`);
    await adapter._executeRaw(createTableSql(tableName, dialect));

    const inserted = await table.createMany({
      data: [
        { id: 'i1', name: 'Alpha', category: 'a', score: 10, embedding: '[1,0,0]' },
        { id: 'i2', name: 'Beta', category: 'a', score: 15, embedding: '[0,1,0]' },
        { id: 'i3', name: 'Gamma', category: null, score: 20, embedding: '[0.9,0.1,0]' },
      ],
    });
    assert.deepStrictEqual(inserted, { count: 3 }, `${dialect}: createMany count`);

    const filtered = await table.findMany({
      where: {
        AND: [
          { name: { contains: 'a' } },
          { score: { gte: 10 } },
        ],
        NOT: { name: { equals: 'Beta' } },
      },
      orderBy: { score: 'asc' },
    });
    assert.deepStrictEqual(filtered.map((row) => row.id), ['i1', 'i3'], `${dialect}: filtered order`);

    const nullRows = await table.findMany({ where: { category: null } });
    assert.deepStrictEqual(nullRows.map((row) => row.id), ['i3'], `${dialect}: null filter`);

    const updated = await table.updateMany({
      where: { category: 'a' },
      data: { score: { increment: 5 } },
    });
    assert.deepStrictEqual(updated, { count: 2 }, `${dialect}: updateMany count`);

    const aggregate = await table.aggregate({
      where: { score: { gte: 15 } },
      _count: true,
      _sum: { score: true },
      _avg: { score: true },
    });
    assert.strictEqual(Number(aggregate._count), 3, `${dialect}: aggregate count`);
    assert.strictEqual(Number(aggregate._sum_score), 55, `${dialect}: aggregate sum`);
    assert.ok(Math.abs(Number(aggregate._avg_score) - 18.3333) < 0.5, `${dialect}: aggregate avg`);

    const grouped = await table.groupBy({
      by: 'category',
      _sum: { score: true },
      orderBy: { category: 'asc' },
    });
    const groupByCategory = Object.fromEntries(grouped.map((row) => [row.category ?? 'null', Number(row._sum_score)]));
    assert.strictEqual(groupByCategory.a, 35, `${dialect}: groupBy category a`);
    assert.strictEqual(groupByCategory.null, 20, `${dialect}: groupBy category null`);

    await assert.rejects(
      () => adapter.$transaction(async (tx) => {
        await tx.table('liveItem').updateMany({ where: { id: 'i1' }, data: { score: { set: 999 } } });
        throw new Error('rollback please');
      }),
      /rollback please/
    );
    const rolledBack = await table.findUnique({ where: { id: 'i1' } });
    assert.strictEqual(Number(rolledBack.score), 15, `${dialect}: transaction rollback`);

    const committed = await adapter.$transaction(async (tx) => {
      return tx.table('liveItem').updateMany({ where: { id: 'i1' }, data: { score: { decrement: 2 } } });
    });
    assert.deepStrictEqual(committed, { count: 1 }, `${dialect}: transaction commit count`);
    const afterCommit = await table.findUnique({ where: { id: 'i1' } });
    assert.strictEqual(Number(afterCommit.score), 13, `${dialect}: transaction commit`);

    const vectorRows = await table.vectorSearch({ vector: [1, 0, 0], take: 2, vectorField: 'embedding' });
    assert.deepStrictEqual(vectorRows.map((row) => row.id), ['i1', 'i3'], `${dialect}: vector fallback ranking`);
    assert.ok(vectorRows.every((row) => typeof row.distance === 'number'), `${dialect}: vector distances`);

    const raw = await adapter.exec(
      `SELECT ${quoteIdent('id', dialect)} FROM ${quotedTable} WHERE ${quoteIdent('score', dialect)} = ${paramCast(dialect, 'score', 'int')}`,
      { score: 13 }
    );
    assert.deepStrictEqual(raw.map((row) => row.id), ['i1'], `${dialect}: raw query`);

    const deleted = await table.deleteMany({ where: { score: { lt: 20 } } });
    assert.deepStrictEqual(deleted, { count: 1 }, `${dialect}: deleteMany count`);
  } finally {
    try { await adapter._executeRaw(`DROP TABLE IF EXISTS ${quotedTable}`); } catch { }
    await adapter.$disconnect().catch(() => {});
  }
}

async function main() {
  if (targets.length === 0) {
    const message = 'No live database URLs configured. Set POSTGRES_DATABASE_URL and/or MSSQL_DATABASE_URL.';
    if (REQUIRE_LIVE_DB) throw new Error(message);
    console.log(`${message} Skipping live DB integration.`);
    return;
  }

  for (const target of targets) {
    console.log(`\n=== Live DB integration: ${target.dialect} ===`);
    await runDialect(target);
    console.log(`✓ ${target.dialect} live DB integration passed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
