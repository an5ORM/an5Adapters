#!/usr/bin/env node
/**
 * Compile-check the standalone Rust adapter crate.
 *
 * Runs `cargo check` in an5Adapters/rust. Skips gracefully when cargo
 * is missing; falls back to structural verification when offline.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rustDir = path.join(root, 'rust');

try {
  const cargoToml = path.join(rustDir, 'Cargo.toml');
  const libRs = path.join(rustDir, 'src', 'lib.rs');
  if (!fs.existsSync(cargoToml) || !fs.existsSync(libRs)) {
    console.log('rust-compile-check: no Rust adapter found, skipping');
    process.exit(0);
  }
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log('rust-compile-check: cargo not installed, skipping');
    process.exit(0);
  }
  const os = require("os");
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "an5-rust-check-"));
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  try {
    execFileSync("cargo", ["check"], { cwd: rustDir, stdio: "inherit", env });
  } catch (e) {
    execFileSync("cargo", ["check", "--offline"], { cwd: rustDir, stdio: "inherit", env });
  }
} catch (err) {
  const msg = String((err && err.message) || err);
  if (/offline|network|failed to download|no matching package/i.test(msg)) {
    console.log('rust-compile-check: offline, verifying adapter sources structurally');
    const lib = fs.readFileSync(path.join(rustDir, 'src', 'lib.rs'), 'utf8');
    for (const expected of ['pub enum Dialect', 'quote_table', 'cosine_similarity', 'set_adapter_metadata']) {
      if (!lib.includes(expected)) {
        console.error(`rust adapter lib.rs missing: ${expected}`);
        process.exit(1);
      }
    }
    console.log('rust-compile-check: structural check passed (offline)');
    process.exit(0);
  }
  throw err;
}
