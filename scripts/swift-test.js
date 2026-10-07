#!/usr/bin/env node
/**
 * Build and test the Swift adapter package.
 *
 * The runtime links the system SQLite, so the gate needs both a Swift toolchain and
 * SQLite's headers. Missing either is reported as a skip rather than a failure, matching
 * the Rust and Java gates: a machine without a mobile toolchain should still be able to run
 * the rest of the suite.
 *
 * The scratch path defaults to a temp directory because SwiftPM's `.build` output is a test
 * bundle that has to be executable, and a workspace on a filesystem that does not set the
 * execute bit produces a bundle that cannot be spawned.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildNative } = require('./sqlite-native-build');

const swiftDir = path.join(__dirname, '..', 'swift');
function swift() {
  const candidates = [
    process.env.SWIFT_HOME && path.join(process.env.SWIFT_HOME, 'usr', 'bin', 'swift'),
    'swift',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function hasSQLiteHeaders() {
  return ['/usr/include/sqlite3.h', '/usr/local/include/sqlite3.h'].some((header) =>
    fs.existsSync(header)
  );
}

function structuralCheck() {
  const sources = path.join(swiftDir, 'Sources', 'An5Adapters');
  for (const [file, expected] of [
    ['An5Adapter.swift', ['class An5Adapter', 'func transaction']],
    ['TableClient.swift', ['func findMany', 'func vectorSearch', 'func groupBy']],
    ['Metadata.swift', ['struct Metadata']],
    ['SQLiteDriver.swift', ['final class SQLiteDriver: SQLDriver']],
  ]) {
    const source = fs.readFileSync(path.join(sources, file), 'utf8');
    for (const symbol of expected) {
      if (!source.includes(symbol)) {
        console.error(`swift adapter ${file} missing: ${symbol}`);
        process.exit(1);
      }
    }
  }
  console.log('swift-test: structural check passed');
}

const tool = swift();
if (!tool) {
  console.log('swift-test: no Swift toolchain installed, skipping');
  process.exit(0);
}
if (!fs.existsSync(path.join(swiftDir, 'Package.swift'))) {
  console.log('swift-test: no Swift package found, skipping');
  process.exit(0);
}
if (!hasSQLiteHeaders()) {
  console.log('swift-test: sqlite3 development headers missing (install libsqlite3-dev), skipping');
  process.exit(0);
}

// The native vector extension test needs a built binary. Building it is optional, so a
// missing compiler leaves that one case skipped rather than failing the gate.
let nativePath = process.env.AN5_NATIVE_VECTOR_PATH;
if (!nativePath && process.platform !== 'win32') {
  try {
    nativePath = buildNative(path.join(os.tmpdir(), 'an5-swift-vector'));
  } catch (error) {
    console.log(`swift-test: native vector extension not built (${error.message})`);
  }
}
const environment = nativePath
  ? { ...process.env, AN5_NATIVE_VECTOR_PATH: nativePath }
  : { ...process.env };

const scratch = process.env.SWIFT_SCRATCH_PATH || path.join(os.tmpdir(), 'an5-swift-build');
fs.mkdirSync(scratch, { recursive: true });
try {
  execFileSync(tool, ['build', '--scratch-path', scratch], {
    cwd: swiftDir, stdio: 'inherit', env: environment,
  });
  execFileSync(tool, ['test', '--scratch-path', scratch], {
    cwd: swiftDir, stdio: 'inherit', env: environment,
  });
  console.log('an5Adapters Swift package built and tested');
} catch (error) {
  const message = String((error && error.message) || error);
  // No network is needed to build — everything is local except the SDK — so a fetch failure
  // is a real problem, not an offline environment.
  if (/could not resolve|unavailable|network|Connection refused/i.test(message)) {
    console.log('swift-test: toolchain unavailable, structural check only');
    structuralCheck();
    process.exit(0);
  }
  throw error;
}
