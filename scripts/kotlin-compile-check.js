#!/usr/bin/env node
/**
 * Compile-check the Kotlin runtime and run it against a real SQLite database.
 *
 * The Kotlin runtime is a front door over the JVM adapter rather than a second
 * implementation, so this compiles both and then exercises the Kotlin API end to end —
 * which is what catches the interop mistakes a Java-only check cannot see: Kotlin's
 * read-only `Map` is not assignable to a `java.util.Map` parameter, and the platform types
 * that come back from JDBC are not what their declarations suggest.
 *
 * Skips when no Kotlin compiler is on PATH, or when the SQLite driver cannot be fetched.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const javaDir = path.join(root, 'java');
const kotlinDir = path.join(root, 'kotlin');
const libDir = process.env.AN5_JAVA_LIB_DIR || path.join(os.tmpdir(), 'an5-java-libs');
const driverUrl =
  'https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.46.1.3/sqlite-jdbc-3.46.1.3.jar';

function sources(dir, extension) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full, extension);
      return entry.name.endsWith(extension) ? [full] : [];
    });
}

// Resolved to an absolute path because the stdlib is found relative to the compiler's
// install directory, and a bare `kotlinc` on PATH has no directory to walk up from.
function toolchain() {
  const candidates = [
    process.env.KOTLIN_HOME && path.join(process.env.KOTLIN_HOME, 'bin', 'kotlinc'),
    'kotlinc',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      if (candidate.includes(path.sep)) return candidate;
      const resolved = execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
      return resolved || candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function structuralCheck() {
  const required = ['An5.kt', 'Query.kt', 'TableClient.kt', 'Aggregate.kt', 'Rows.kt', 'Types.kt'];
  const source = path.join(kotlinDir, 'src', 'main', 'kotlin', 'an5', 'adapters');
  for (const file of required) {
    if (!fs.existsSync(path.join(source, file))) {
      console.error(`kotlin adapter missing: ${file}`);
      process.exit(1);
    }
  }
  console.log('kotlin-compile-check: structural check passed');
}

const kotlinc = toolchain();
if (!kotlinc) {
  console.log('kotlin-compile-check: kotlinc not installed, skipping');
  process.exit(0);
}

// Where the stdlib sits depends on how the compiler was installed: a KOTLIN_HOME distro
// has it under `lib`, an apt/symlink install only shows it once the link is resolved. The
// candidates are tried in order rather than assumed from one layout, because the smoke is
// run by the JVM and without the jar the class files load and then fail on the first
// stdlib reference.
function kotlinStdlib(compiler) {
  let real = compiler;
  try {
    real = fs.realpathSync(compiler);
  } catch {
    // the compiler was found by toolchain(), so keep the path as given
  }
  const roots = [
    process.env.KOTLIN_HOME,
    path.dirname(path.dirname(real)),
    path.dirname(path.dirname(path.dirname(real))),
  ].filter(Boolean);
  for (const root of roots) {
    const jar = path.join(root, 'lib', 'kotlin-stdlib.jar');
    if (fs.existsSync(jar)) return jar;
  }
  return null;
}
if (!fs.existsSync(path.join(kotlinDir, 'src', 'main', 'kotlin'))) {
  console.log('kotlin-compile-check: no Kotlin adapter found, skipping');
  process.exit(0);
}

let javac;
try {
  execFileSync('javac', ['-version'], { stdio: 'ignore' });
  javac = 'javac';
} catch {
  const home = process.env.JAVA_HOME;
  if (!home) {
    console.log('kotlin-compile-check: no JDK installed, skipping');
    process.exit(0);
  }
  javac = path.join(home, 'bin', 'javac');
  execFileSync(javac, ['-version'], { stdio: 'ignore' });
}
const java = javac.replace(/javac$/, 'java');

fs.mkdirSync(libDir, { recursive: true });
const driverJar = path.join(libDir, path.basename(driverUrl));
if (!fs.existsSync(driverJar)) {
  try {
    console.log(`kotlin-compile-check: fetching ${path.basename(driverJar)}`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', '-o', driverJar, driverUrl], {
      stdio: 'inherit',
    });
  } catch {
    console.log('kotlin-compile-check: sqlite-jdbc unavailable, structural check only');
    structuralCheck();
    process.exit(0);
  }
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'an5-kotlin-'));
try {
  const classes = path.join(outDir, 'classes');
  fs.mkdirSync(classes, { recursive: true });
  const javaList = path.join(outDir, 'java-sources.txt');
  fs.writeFileSync(javaList, sources(path.join(javaDir, 'src', 'main', 'java'), '.java').join('\n'), 'utf8');
  execFileSync(javac, ['-d', classes, `@${javaList}`], { stdio: 'inherit' });

  const kotlinFiles = [
    ...sources(path.join(kotlinDir, 'src', 'main', 'kotlin'), '.kt'),
    ...sources(path.join(kotlinDir, 'src', 'test', 'kotlin'), '.kt'),
  ];
  // The stdlib travels with the compiler, so it is both on the compile classpath and the
  // runtime one; without it the class files load and then fail on the first null check.
  const stdlib = kotlinStdlib(kotlinc);
  const runtimeClasspath = [outDir, classes, stdlib, driverJar]
    .filter((entry) => fs.existsSync(entry))
    .join(path.delimiter);
  execFileSync(
    kotlinc,
    ['-classpath', [classes, stdlib, driverJar].filter((entry) => fs.existsSync(entry)).join(path.delimiter), '-d', outDir, ...kotlinFiles],
    { stdio: 'inherit' }
  );

  // An `object` with `@JvmStatic fun main` is its own JVM class; a bare top-level `main`
  // lands in a `<File>Kt` holder. Either is a valid entry point, so look for both.
  const testDir = path.join(kotlinDir, 'src', 'test', 'kotlin');
  const mainClass = kotlinFiles
    .filter((file) => file.startsWith(testDir))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .map((source) => {
      const pkg = /^package\s+(\S+)/m.exec(source);
      const prefix = pkg ? pkg[1] + '.' : '';
      const object = /\bobject\s+(\w+)[^{]*\{[\s\S]*?@JvmStatic\s+fun main/.exec(source);
      if (object) return prefix + object[1];
      return /fun main\(/.test(source) && !/@JvmStatic/.test(source)
        ? prefix + path.basename(file, '.kt') + 'Kt'
        : null;
    })
    .find(Boolean);
  if (!mainClass) {
    console.log('kotlin-compile-check: compiled clean, no smoke entry point to run');
    process.exit(0);
  }
  if (!stdlib) {
    console.log('kotlin-compile-check: kotlin-stdlib.jar not found next to the compiler, compiled but not run');
    process.exit(0);
  }
  execFileSync(
    java,
    ['-cp', runtimeClasspath, mainClass],
    { stdio: 'inherit' }
  );
  console.log('an5Adapters Kotlin compile and runtime smoke passed');
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}