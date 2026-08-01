/**
 * @an5/adapters package-level regression tests
 * Verify built artifacts (dist) expose the full public API surface.
 * Run: node test/package.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');

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

function assertHas(moduleObj, name) {
  assert.ok(moduleObj, `module is undefined`);
  assert.ok(moduleObj[name] !== undefined, `missing export: ${name}`);
}

function assertFn(moduleObj, name) {
  assertHas(moduleObj, name);
  assert.strictEqual(typeof moduleObj[name], 'function', `"${name}" should be a function/class`);
}

console.log('\n=== Package-level regression tests ===\n');

let pkg;
let browser;
let sheets;

try {
  pkg = require(root);
} catch (err) {
  pkg = undefined;
  console.log(`  ! failed to require package root: ${err.message}`);
}

try {
  browser = require(path.join(root, 'dist', 'browser.js'));
} catch (err) {
  browser = undefined;
  console.log(`  ! failed to require ./browser: ${err.message}`);
}

try {
  sheets = require(path.join(root, 'dist', 'googlesheets'));
} catch (err) {
  sheets = undefined;
  console.log(`  ! failed to require ./googlesheets: ${err.message}`);
}

// ─── Root entry (.) ──────────────────────────────────────────────────────────

console.log('\nPackage root exports:');

test('package root loads', () => {
  assert.ok(pkg, 'require(<pkg root>) should not throw');
});

test('core adapter exports', () => {
  assertFn(pkg, 'An5Adapter');
  assertFn(pkg, 'AdapterTableClient');
  assertFn(pkg, 'createAn5Adapter');
  assertFn(pkg, 'setAdapterMetadata');
});

test('config exports', () => {
  assertFn(pkg, 'getLlmConfig');
  assertFn(pkg, 'setLlmConfig');
  assertFn(pkg, 'getEmbeddingConfig');
  assertFn(pkg, 'setEmbeddingConfig');
  assertFn(pkg, 'resetAdapter');
});

test('Google Sheets exports are present at package root', () => {
  assertFn(pkg, 'An5SheetsAdapter');
  assertFn(pkg, 'SheetsTableClient');
  assertFn(pkg, 'createAn5SheetsAdapter');
  assertFn(pkg, 'parseSheetsConnectionString');
});

// ─── Browser entry (./browser) ───────────────────────────────────────────────

console.log('\nBrowser entry exports:');

test('browser entry loads', () => {
  assert.ok(browser, 'require(<pkg>/browser) should not throw');
});

test('browser entry exposes Sheets API', () => {
  assertFn(browser, 'An5SheetsAdapter');
  assertFn(browser, 'SheetsTableClient');
  assertFn(browser, 'createAn5SheetsAdapter');
  assertFn(browser, 'parseSheetsConnectionString');
});

test('browser entry exposes metadata helpers', () => {
  assertFn(browser, 'setAdapterMetadata');
  assertFn(browser, 'getFieldsForModel');
  assertFn(browser, 'getModelToTable');
});

// ─── Subpath entry (./googlesheets) ──────────────────────────────────────────

console.log('\n./googlesheets subpath exports:');

test('googlesheets subpath loads', () => {
  assert.ok(sheets, 'require(<pkg>/googlesheets) should not throw');
});

test('googlesheets subpath exposes Sheets API', () => {
  assertFn(sheets, 'An5SheetsAdapter');
  assertFn(sheets, 'SheetsTableClient');
  assertFn(sheets, 'createAn5SheetsAdapter');
  assertFn(sheets, 'parseSheetsConnectionString');
});

// ─── SQL engine subpaths resolve ─────────────────────────────────────────────

console.log('\nSQL engine subpaths:');

['mssql', 'postgres', 'mysql', 'sqlite'].forEach((dialect) => {
  test(`./${dialect} subpath resolves`, () => {
    const mod = require(path.join(root, 'dist', dialect));
    assert.ok(mod && typeof mod === 'object', `./${dialect} should resolve to a module`);
  });
});

// ─── Behavior smoke (no network) ─────────────────────────────────────────────

console.log('\nBehavior smoke:');

test('createAn5Adapter returns an adapter', () => {
  const adapter = pkg.createAn5Adapter({ type: 'sqlite', connectionString: 'file::memory:' });
  assert.ok(adapter, 'createAn5Adapter() should return an adapter');
  assert.ok(typeof adapter.exec === 'function', 'adapter should expose exec()');
});

test('parseSheetsConnectionString parses config', () => {
  const cfg = pkg.parseSheetsConnectionString(
    'googlesheets://abc123;clientEmail=x@y.iam.gserviceaccount.com;sheetMapping=users:Users'
  );
  assert.strictEqual(cfg.spreadsheetId, 'abc123', 'spreadsheetId parsed');
  assert.strictEqual(cfg.clientEmail, 'x@y.iam.gserviceaccount.com', 'clientEmail parsed');
  assert.deepStrictEqual(cfg.sheetMapping, { users: 'Users' }, 'sheetMapping parsed');
});

test('createAn5SheetsAdapter returns a Sheets adapter', () => {
  const adapter = pkg.createAn5SheetsAdapter({ spreadsheetId: 'abc123', apiKey: 'k' });
  assert.ok(adapter, 'createAn5SheetsAdapter() should return an adapter');
  assert.strictEqual(adapter.config.spreadsheetId, 'abc123', 'adapter carries spreadsheetId');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

process.exit(failed > 0 ? 1 : 0);
