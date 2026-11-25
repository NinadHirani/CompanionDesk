'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const Settings = require('../src/settings');

test('companionName falls back to CompanionDesk and trims the setting', () => {
  assert.equal(Settings.companionName({}), 'CompanionDesk');
  assert.equal(Settings.companionName({ assistant_name: '   ' }), 'CompanionDesk');
  assert.equal(Settings.companionName({ assistant_name: null }), 'CompanionDesk');
  assert.equal(Settings.companionName({ assistant_name: '  Nova  ' }), 'Nova');
  assert.equal(Settings.companionName({ assistant_name: 'a'.repeat(50) }).length, 40);
});

test('companionGreeting uses the user name when set, the name alone otherwise', () => {
  assert.equal(
    Settings.companionGreeting({ user_name: 'Ninad', assistant_name: 'Nova' }),
    'Hi Ninad, Nova here. Ask me about your deadlines, courses or notes.'
  );
  assert.equal(
    Settings.companionGreeting({ user_name: '', assistant_name: '' }),
    'CompanionDesk here. Ask me about your deadlines, courses or notes.'
  );
});

test('both state_get surfaces ship settings and identity', () => {
  for (const f of ['src/main.js', 'src/web/bridge.js']) {
    const body = fs.readFileSync(f, 'utf8');
    const start = body.indexOf(f.endsWith('main.js') ? "'state:get'" : 'async function state_get()');
    assert.ok(start > 0, `${f} has a state_get`);
    const chunk = body.slice(start, start + 1200);
    assert.ok(/settings:/.test(chunk), `${f} state_get includes settings`);
    assert.ok(/identity:/.test(chunk), `${f} state_get includes identity`);
    assert.ok(/companionGreeting/.test(chunk), `${f} builds the greeting from settings`);
  }
});

test('both shells expose the identity anchors and app.js applies them', () => {
  for (const shell of ['renderer/index.html', 'web/index.html']) {
    const html = fs.readFileSync(shell, 'utf8');
    assert.ok(html.includes('id="app-title"'), `${shell} has app-title`);
    assert.ok(html.includes('id="ask-greet"'), `${shell} has ask-greet`);
  }
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.ok(/applyIdentity\(state\)/.test(app), 'refresh applies identity');
  assert.ok(/getElementById\('app-title'\)/.test(app) && /getElementById\('ask-greet'\)/.test(app));
});
