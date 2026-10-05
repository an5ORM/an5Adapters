#!/usr/bin/env node
/**
 * Run the Java adapter against a real SQLite database.
 *
 * A compile check cannot see whether the generated SQL is valid, so this builds the
 * adapter plus its tests and runs them on an in-memory SQLite through the Xerial JDBC
 * driver — the same driver a JVM consumer would use.
 *
 * The driver jar is downloaded once into a shared temp directory. When it cannot be
 * fetched the gate degrades to the structural check rather than failing the suite, the
 * way the Rust gate degrades when crates.io is unreachable.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const javaDir = path.join(root, 'java');
const libDir = process.env.AN5_JAVA_LIB_DIR || path.join(os.tmpdir(), 'an5-java-libs');
const driverUrl =
  'https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.46.1.3/sqlite-jdbc-3.46.1.3.jar';

function sources(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.name.endsWith('.java') ? [full] : [];
    });
}

function structuralCheck() {
  const files = [
    ['src/main/java/an5/adapters/An5Adapter.java', ['class An5Adapter', 'transaction(']],
    ['src/main/java/an5/adapters/An5TableClient.java', ['findMany(', 'vectorSearch(', 'groupBy(']],
    ['src/main/java/an5/adapters/base/Metadata.java', ['setAdapterMetadata']],
  ];
  for (const [relative, expected] of files) {
    const source = fs.readFileSync(path.join(javaDir, relative), 'utf8');
    for (const symbol of expected) {
      if (!source.includes(symbol)) {
        console.error(`java adapter ${relative} missing: ${symbol}`);
        process.exit(1);
      }
    }
  }
  console.log('java-sqlite-smoke: structural check passed');
}

let javac;
try {
  execFileSync('javac', ['-version'], { stdio: 'ignore' });
  javac = 'javac';
} catch {
  try {
    const home = process.env.JAVA_HOME;
    if (!home) throw new Error('JAVA_HOME not set');
    javac = path.join(home, 'bin', 'javac');
    execFileSync(javac, ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('java-sqlite-smoke: no JDK installed, skipping');
    process.exit(0);
  }
}

const javaBin = javac.replace(/javac$/, 'java');
fs.mkdirSync(libDir, { recursive: true });
const driverJar = path.join(libDir, path.basename(driverUrl));

if (!fs.existsSync(driverJar)) {
  try {
    console.log(`java-sqlite-smoke: fetching ${path.basename(driverJar)}`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', '-o', driverJar, driverUrl], {
      stdio: 'inherit',
    });
  } catch {
    console.log('java-sqlite-smoke: sqlite-jdbc unavailable, structural check only');
    structuralCheck();
    process.exit(0);
  }
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-java-smoke-'));
const listFile = path.join(outDir, 'sources.txt');
try {
  const files = [...sources(path.join(javaDir, 'src', 'main', 'java')), ...sources(path.join(javaDir, 'src', 'test', 'java'))];
  fs.writeFileSync(listFile, files.join('\n'), 'utf8');
  execFileSync(javac, ['-d', outDir, `@${listFile}`], { stdio: 'inherit' });
  execFileSync(javaBin, ['-cp', `${outDir}${path.delimiter}${driverJar}`, 'An5AdaptersSmoke'], {
    stdio: 'inherit',
  });
  execFileSync(
    javaBin,
    ['-cp', `${outDir}${path.delimiter}${driverJar}`, 'QuerySemantics', path.join(root, 'test', 'fixtures', 'query-semantics.json')],
    { stdio: 'inherit' }
  );
  console.log('an5Adapters Java runtime smoke passed');
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}