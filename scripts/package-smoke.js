#!/usr/bin/env node
/**
 * @an5/adapters package smoke test.
 *
 * Packs the package with `npm pack`, installs the tarball into a fresh temp
 * project, then verifies the installed package:
 *   - root entry exposes the full API surface (incl. Google Sheets)
 *   - every subpath entry resolves
 *   - real SQLite CRUD works through createAn5Adapter
 *   - Sheets config parsing + connection-string auto-detection work
 *
 * Run: node scripts/package-smoke.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-adapters-smoke-'));
const packDir = path.join(tmp, 'pack');
const projDir = path.join(tmp, 'proj');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_config_')) delete env[key];
  }
  return env;
}

function run(cmd, cwd) {
  const out = execSync(cmd, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

try {
  console.log('\n=== @an5/adapters package smoke test ===\n');

  console.log('[0] npm pack');
  const packOut = run(`npm pack --pack-destination "${packDir}"`, root);
  const tarball = packOut
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith('.tgz'));
  if (!tarball) throw new Error(`no .tgz produced by npm pack:\n${packOut}`);
  console.log(`    packed ${tarball}`);

  console.log('[1] install into fresh project');
  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify({ name: 'an5-adapters-smoke', version: '1.0.0', private: true }, null, 2),
    'utf8'
  );
  const installOut = run(
    `npm install --no-audit --no-fund "${path.join(packDir, tarball)}" better-sqlite3`,
    projDir
  );
  if (/npm error/i.test(installOut)) throw new Error(`npm install failed:\n${installOut}`);

  const smokeProbe = path.join(projDir, 'smoke.js');
  fs.writeFileSync(
    smokeProbe,
    [
      `const assert = require('assert');`,
      `let passed = 0, failed = 0;`,
      `function test(name, fn) { try { fn(); passed++; console.log('  OK ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\\n    ' + e.message); } }`,
      ``,
      `const root = require('@an5/adapters');`,
      `test('root: core exports', () => {`,
      `  ['An5Adapter','AdapterTableClient','createAn5Adapter','setAdapterMetadata','getLlmConfig','setLlmConfig','getEmbeddingConfig','setEmbeddingConfig','resetAdapter'].forEach(n => assert.strictEqual(typeof root[n], 'function', 'missing ' + n));`,
      `});`,
      `test('root: Google Sheets exports', () => {`,
      `  ['An5SheetsAdapter','SheetsTableClient','createAn5SheetsAdapter','parseSheetsConnectionString'].forEach(n => assert.strictEqual(typeof root[n], 'function', 'missing ' + n));`,
      `});`,
      `test('browser entry', () => {`,
      `  const b = require('@an5/adapters/browser');`,
      `  ['An5SheetsAdapter','SheetsTableClient','createAn5SheetsAdapter','parseSheetsConnectionString','setAdapterMetadata'].forEach(n => assert.strictEqual(typeof b[n], 'function', 'missing ' + n));`,
      `});`,
      `test('googlesheets entry', () => {`,
      `  const g = require('@an5/adapters/googlesheets');`,
      `  ['An5SheetsAdapter','SheetsTableClient','createAn5SheetsAdapter','parseSheetsConnectionString'].forEach(n => assert.strictEqual(typeof g[n], 'function', 'missing ' + n));`,
      `});`,
      `['mssql','postgres','mysql','sqlite','base','config'].forEach(sub => {`,
      `  test('./' + sub + ' resolves', () => assert.ok(require('@an5/adapters/' + sub)));`,
      `});`,
      `test('sqlite CRUD end-to-end', async () => {`,
      `  const a = root.createAn5Adapter({ type: 'sqlite', connectionString: 'sqlite:///:memory:' });`,
      `  await a.$connect();`,
      `  await a.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');`,
      `  assert.strictEqual(await a.executeRaw('INSERT INTO users (name) VALUES (@name)', { name: 'Alice' }), 1);`,
      `  const rows = await a.exec('SELECT * FROM users WHERE name = @name', { name: 'Alice' });`,
      `  assert.strictEqual(rows.length, 1);`,
      `  assert.strictEqual(rows[0].name, 'Alice');`,
      `  await a.$disconnect();`,
      `});`,
      `test('parseSheetsConnectionString', () => {`,
      `  const cfg = root.parseSheetsConnectionString('googlesheets://sp_123;clientEmail=sa@x.iam.gserviceaccount.com;sheetMapping=users:Users,orders:Orders');`,
      `  assert.strictEqual(cfg.spreadsheetId, 'sp_123');`,
      `  assert.strictEqual(cfg.clientEmail, 'sa@x.iam.gserviceaccount.com');`,
      `  assert.deepStrictEqual(cfg.sheetMapping, { users: 'Users', orders: 'Orders' });`,
      `});`,
      `test('createAn5SheetsAdapter + googlesheets:// auto-detect', () => {`,
      `  const s = root.createAn5SheetsAdapter({ spreadsheetId: 'sp_123', apiKey: 'k' });`,
      `  assert.strictEqual(s.config.spreadsheetId, 'sp_123');`,
      `  assert.ok(root.createAn5Adapter({ connectionString: 'googlesheets://sp_123;apiKey=k' }));`,
      `});`,
      `console.log('\\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');`,
      `process.exit(failed > 0 ? 1 : 0);`,
      ``
    ].join('\n'),
    'utf8'
  );

  console.log('[2] run smoke checks');
  run(`node smoke.js`, projDir);
  console.log('\nPackage smoke test: PASSED');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
