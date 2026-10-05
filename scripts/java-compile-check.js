#!/usr/bin/env node
/**
 * Compile-check the standalone Java adapter sources.
 *
 * The npm package ships raw `.java` sources rather than a jar, so this compiles the
 * shipped tree directly with `javac`. `-Werror` is deliberate: the sources are also
 * compiled by Android builds and by Kotlin consumers, and a warning that passes here
 * becomes an error in a stricter downstream toolchain.
 *
 * Skips when no JDK is on PATH rather than failing, so a workspace without one can
 * still run the rest of the suite.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceDir = path.join(__dirname, '..', 'java', 'src', 'main', 'java');

function sources(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.name.endsWith('.java') ? [full] : [];
    });
}

// JAVA_HOME first: CI installs a JDK there without putting javac on PATH, so a PATH-only
// lookup would skip the gate on the machine that most needs it.
let javac = null;
const fromHome =
  process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'javac');
for (const candidate of [fromHome, 'javac'].filter(Boolean)) {
  try {
    execFileSync(candidate, ['-version'], { stdio: 'ignore' });
    javac = candidate;
    break;
  } catch {
    // try the next candidate
  }
}
if (!javac) {
  console.log('java-compile-check: javac not installed, skipping');
  process.exit(0);
}

if (!fs.existsSync(sourceDir)) {
  console.log('java-compile-check: no Java adapter found, skipping');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-java-classes-'));
const listFile = path.join(outDir, 'sources.txt');
try {
  const files = sources(sourceDir);
  fs.writeFileSync(listFile, files.join('\n'), 'utf8');
  execFileSync(javac, ['-Xlint:all', '-Werror', '-d', outDir, `@${listFile}`], { stdio: 'inherit' });
  console.log(`an5Adapters Java sources compile clean (${javac})`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}