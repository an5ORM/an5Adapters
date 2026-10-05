/**
 * The npm and PyPI versions must agree.
 *
 * They are two fields maintained by hand, in two files, and nothing compared
 * them. `an5-orm` was at 1.0.9 on PyPI while `@an5/orm` reached 1.0.12 on npm,
 * because every release bumped package.json and forgot pyproject.toml. The
 * publish job does not fail when it skips an existing version, so each run
 * quietly built and skipped the old one: PyPI had not received a new release
 * through this pipeline at all.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

function readVersion(file) {
  const match = fs.readFileSync(path.join(root, file), 'utf8').match(/^version = "(.+)"$/m);
  assert.ok(match, `Expected a version field in ${file}`);
  return match[1];
}

for (const pkg of ['an5-orm', 'an5-adapters']) {
  test(`${pkg}: the PyPI version matches the npm version`, () => {
    const npmVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    assert.equal(
      readVersion('pyproject.toml'),
      npmVersion,
      'pyproject.toml and package.json disagree — bump both, or the publish ' +
        'step will build the old version and skip it as already published',
    );
  });
}

test('the project name on PyPI is the one that is published there', () => {
  const match = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8').match(/^name = "(.+)"$/m);
  assert.equal(match[1], 'an5-adapters');
});

/**
 * The JVM modules publish to Maven Central under their own coordinates, and both versions
 * are maintained by hand in build files nothing else reads. A stale one means Central is
 * asked for a version that already exists (rejected) or a consumer's dependency, written
 * from the README, resolves to an older jar.
 */
const npmVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

test('the Java module publishes the npm version', () => {
  const pom = fs.readFileSync(path.join(root, 'java', 'pom.xml'), 'utf8');
  const match = pom.match(/<version>(.+?)<\/version>/);
  assert.ok(match, 'Expected a <version> in java/pom.xml');
  assert.equal(
    match[1],
    npmVersion,
    'java/pom.xml and package.json disagree — the Central upload and the npm ' +
      'package would describe different releases',
  );
});

test('the Kotlin module publishes the npm version', () => {
  const gradle = fs.readFileSync(path.join(root, 'kotlin', 'build.gradle.kts'), 'utf8');
  const match = gradle.match(/^version = "(.+)"$/m);
  assert.ok(match, 'Expected a version = "..." in kotlin/build.gradle.kts');
  assert.equal(
    match[1],
    npmVersion,
    'kotlin/build.gradle.kts and package.json disagree — the Kotlin artifact ' +
      'would be published under the wrong version',
  );
});
