#!/usr/bin/env node
/**
 * Compile-check the standalone Rust adapter crate.
 *
 * Runs `cargo check` in an5Adapters/rust. Skips gracefully when cargo is
 * missing; falls back to structural verification when crates.io is unreachable.
 *
 * Uses a shared CARGO_TARGET_DIR so the sqlx dependency tree is compiled once
 * per CI run and reused by the other Rust gates in the workspace.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const rustDir = path.join(root, 'rust');

function structuralCheck() {
  const lib = fs.readFileSync(path.join(rustDir, 'src', 'lib.rs'), 'utf8');
  for (const expected of [
    'pub enum Dialect',
    'quote_table',
    'cosine_similarity',
    'set_adapter_metadata',
  ]) {
    if (!lib.includes(expected)) {
      console.error(`rust adapter lib.rs missing: ${expected}`);
      process.exit(1);
    }
  }
  console.log('rust-compile-check: structural check passed');
}

if (!fs.existsSync(path.join(rustDir, 'Cargo.toml')) || !fs.existsSync(path.join(rustDir, 'src', 'lib.rs'))) {
  console.log('rust-compile-check: no Rust adapter found, skipping');
  process.exit(0);
}
try {
  execFileSync('cargo', ['--version'], { stdio: 'ignore' });
} catch {
  console.log('rust-compile-check: cargo not installed, skipping');
  process.exit(0);
}

const targetDir = process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'an5-cargo-target');
fs.mkdirSync(targetDir, { recursive: true });
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };

try {
  execFileSync('cargo', ['check'], { cwd: rustDir, stdio: 'inherit', env });
  console.log('an5Adapters Rust crate cargo check passed');
} catch (err) {
  const msg = String((err && err.message) || err);
  if (/offline|network|failed to download|no matching package|failed to query/i.test(msg)) {
    console.log('rust-compile-check: crates.io unreachable, structural check only');
    structuralCheck();
  } else {
    throw err;
  }
}
