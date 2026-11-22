'use strict';

// Pins the properties that matter for the Android CI workflow: it builds a
// debug APK from the committed Capacitor project, uploads it as a workflow
// artifact (never a release), needs no more than read access, and reuses the
// same web bundle the desktop CI already assembles. The Electron desktop
// build path is untouched by this workflow.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'android-apk.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));

test('the android workflow runs by hand and when mobile files change on main', () => {
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /branches: \[ main \]/);
});

test('it builds a debug APK with the committed gradle wrapper', () => {
  assert.match(yml, /assembleDebug/);
  assert.ok(fs.existsSync(path.join(root, 'android', 'gradlew')), 'android/gradlew must be committed');
  assert.ok(
    fs.existsSync(path.join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar')),
    'gradle-wrapper.jar must be committed'
  );
});

test('it assembles the same web bundle desktop CI builds, then syncs it into android', () => {
  assert.match(yml, /build-web\.sh/);
  assert.match(yml, /cap sync android/);
});

test('the APK ships as a workflow artifact, never a release', () => {
  assert.match(yml, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(yml, /gh release|softprops|contents: write|ghr/i);
});

test('it needs no write access and holds no secrets', () => {
  assert.match(yml, /permissions:\r?\n  contents: read/);
  assert.doesNotMatch(yml, /secrets\./);
});

test('the capacitor app id matches the android namespace and webDir', () => {
  assert.match(gradle, /namespace "app\.companiondesk\.assistant"/);
  assert.equal(config.appId, 'app.companiondesk.assistant');
  assert.equal(config.webDir, 'web');
});

test('the capacitor toolchain is pinned as dev dependencies', () => {
  for (const name of ['@capacitor/core', '@capacitor/cli', '@capacitor/android']) {
    assert.ok(pkg.devDependencies[name], `package.json devDependencies must define "${name}"`);
  }
});
