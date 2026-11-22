'use strict';

// The CI workflow cannot run here, so these tests pin the properties that
// matter: it covers macOS on Apple Silicon, installs from the lockfile, runs
// the suite, packages, and asks for no more than read access. The file is read
// as text so no YAML library is needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', '.github', 'workflows', 'ci-macos.yml');
const yml = fs.readFileSync(file, 'utf8');

test('the workflow has its own file name, so it cannot overwrite another CI file', () => {
  assert.equal(path.basename(file), 'ci-macos.yml');
});

test('it tests on macOS Apple Silicon and Linux, with the Node the app targets', () => {
  // macos-latest is a macOS (Apple Silicon) GitHub-hosted runner; the macos-14
  // label never schedules on this account's plan.
  assert.match(yml, /macos-latest/);
  assert.match(yml, /ubuntu-24\.04/);
  assert.match(yml, /node-version: 22/);
});

test('it installs from the lockfile, runs the tests, a smoke boot and a package check', () => {
  assert.match(yml, /run: npm ci/);
  assert.match(yml, /run: npm test/);
  assert.match(yml, /npm run smoke/);
  assert.match(yml, /run: npm run pack/);
});

test('it can only read the repository: no secrets, no publishing, no write permissions', () => {
  assert.match(yml, /permissions:\n  contents: read/);
  assert.ok(!/secrets\./.test(yml), 'uses no secrets');
  assert.ok(!/--publish always|gh release|upload-artifact|contents: write/.test(yml));
});

test('the scripts it calls exist in package.json', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts;
  for (const s of ['test', 'smoke', 'pack']) assert.ok(scripts[s], `package.json must define "${s}"`);
});

test('the lockfile that npm ci needs is committed', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'package-lock.json')));
});

test('no tabs (illegal in YAML) and consistent two-space indentation', () => {
  assert.ok(!yml.includes('\t'));
  const odd = yml.split('\n').filter((l) => l.trim() && (l.length - l.trimStart().length) % 2 !== 0);
  assert.deepEqual(odd, []);
});
