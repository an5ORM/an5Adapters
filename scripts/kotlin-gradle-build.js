#!/usr/bin/env node
/**
 * Run the Kotlin adapter through its own Gradle manifest.
 *
 * The manifest is the file a Kotlin consumer resolves, so it has to be exercised rather
 * than read: `useJUnitPlatform()` without an engine, a wrong dependency scope or a broken
 * repository block all compile fine in review and fail on someone else's machine. Gradle
 * also compiles and runs the smoke (`check` depends on it), which is a different path from
 * the kotlinc gate — this one goes through the Java adapter as a resolved artifact.
 *
 * The Java runtime comes from the local Maven repository (`mvn -f java/pom.xml install`),
 * the same step a checkout takes; missing toolchains and an unreachable plugin repository
 * are reported as skips rather than failures, the way the other language gates degrade.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const javaDir = path.join(root, 'java');
const kotlinDir = path.join(root, 'kotlin');
const gradleWrapper = path.join(kotlinDir, 'gradlew');

function skip(reason) {
  console.log(`kotlin-gradle-build: ${reason}, skipping`);
  process.exit(0);
}

function command(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function isNetworkFailure(error) {
  const output = `${error.message || ''}${error.stderr || ''}`;
  return /Could not resolve|Could not download|Connection (refused|reset|timed out)|UnknownHost|No space left|timed? ?out/i.test(
    output,
  );
}

function gradleCommand() {
  if (fs.existsSync(gradleWrapper)) return gradleWrapper;
  const candidates = [process.env.GRADLE_HOME && path.join(process.env.GRADLE_HOME, 'bin', 'gradle'), 'gradle'].filter(
    Boolean,
  );
  for (const candidate of candidates) {
    try {
      command(candidate, ['-version']);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

if (!fs.existsSync(path.join(kotlinDir, 'build.gradle.kts'))) {
  skip('no Kotlin Gradle manifest found');
}

const gradle = gradleCommand();
if (!gradle) skip('Gradle not installed');

const javac = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javac') : 'javac';
try {
  command(javac, ['-version']);
} catch {
  skip('no JDK installed');
}

// The Java sibling is resolved from ~/.m2 by `mavenLocal()`; install it when that version is
// not there yet, and let an unreachable repository degrade the gate instead of failing it.
// The path follows the published coordinates `io.github.an5orm:an5-adapters-java`; the
// pre-release `org.an5orm` directory never existed locally, so the check below was always
// false and every run paid for a fresh `mvn install`.
const version = require(path.join(root, 'package.json')).version;
const installed = fs.existsSync(
  path.join(
    os.homedir(),
    '.m2',
    'repository',
    'io',
    'github',
    'an5orm',
    'an5-adapters-java',
    version,
    `an5-adapters-java-${version}.pom`,
  ),
);
if (!installed) {
  try {
    command('mvn', ['-q', '-B', '-f', path.join(javaDir, 'pom.xml'), 'install', '-DskipTests'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    if (isNetworkFailure(error)) skip('Maven repository unreachable while installing the Java adapter');
    throw error;
  }
}

try {
  // The version is printed because the Test task's rules differ across Gradle majors, and
  // a failure without it cannot be told from a broken manifest.
  const version = (command(gradle, ['-version']).match(/^Gradle .*$/m) || ['unknown'])[0];
  console.log(`kotlin-gradle-build: ${gradle} (${version})`);
  command(gradle, ['build', '--console=plain', '--no-daemon'], { cwd: kotlinDir });
} catch (error) {
  if (isNetworkFailure(error)) skip('Gradle plugin repository unreachable');
  process.stderr.write(error.stderr || error.message || String(error));
  process.exit(1);
}

console.log('kotlin-gradle-build: gradle build passed');
