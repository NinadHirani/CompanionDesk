'use strict';
// Gate 2 delivery display slice: proves the pure display shaper and the
// panel's read-only rendering boundaries: bounded newest-first display cap,
// malformed-record skipping, no mutation of inputs, hostile markup passed
// through as plain text only, the panel file itself free of markup-setting
// surfaces, and the script include order plus CSP unchanged in index.html.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { shape, MAX_DISPLAY } = require('../src/agent-notifications-view');
const { createNotificationDesk } = require('../src/agent-notifications');

function rec(i, over = {}) {
  return Object.assign({
    id: 'ntf-' + String(i).padStart(6, '0'),
    title: 'T' + i,
    body: 'B' + i,
    priority: 'normal',
    createdAt: 1000 + i,
    read: false,
  }, over);
}

test('view: caps display at 10 and shows newest first', () => {
  const records = [];
  for (let i = 1; i <= 14; i++) records.push(rec(i));
  const out = shape(records);
  assert.equal(out.ok, true);
  assert.equal(out.shown, 10);
  assert.equal(out.hidden, 4);
  assert.equal(out.skipped, 0);
  assert.equal(out.total, 14);
  assert.equal(out.lines[0].includes('T14'), true);
  assert.equal(out.lines[9].includes('T5'), true);
  assert.equal(MAX_DISPLAY, 10);
});

test('view: max may only lower the cap; invalid max is refused', () => {
  const records = [rec(1), rec(2), rec(3)];
  const out = shape(records, { max: 2 });
  assert.equal(out.shown, 2);
  assert.equal(out.hidden, 1);
  for (const max of [0, -1, 1.5, '3']) {
    const bad = shape(records, { max });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'max_invalid');
  }
});

test('view: long titles and bodies are truncated for display', () => {
  // at the source caps (title 200, body 500): accepted, then truncated
  const out = shape([rec(1, { title: 'x'.repeat(200), body: 'y'.repeat(500) })]);
  assert.equal(out.shown, 1);
  const line = out.lines[0];
  assert.ok(line.length < 400);
  assert.equal(line.includes('\u2026'), true);
  // a title BEYOND the source cap is malformed input, skipped not truncated
  const refused = shape([rec(2, { title: 'x'.repeat(300) })]);
  assert.equal(refused.shown, 0);
  assert.equal(refused.skipped, 1);
});

test('view: malformed records are skipped and counted, never displayed or thrown on', () => {
  const hostile = [
    null,
    42,
    'record',
    [],
    Object.create({ inherited: true }, { id: { value: 'ntf-000001', enumerable: true } }),
    Object.assign(rec(1), { extra: 'hostile key' }),
    (() => { const r = rec(1); r[Symbol('s')] = 'x'; return r; })(),
    Object.defineProperty(rec(1), 'title', { get() { return 'T'; } }),
    rec(1, { id: 'X' }),
    rec(1, { priority: 'urgent' }),
    rec(1, { read: 'yes' }),
    rec(1, { createdAt: 'not-a-number' }),
  ];
  const out = shape(hostile.concat([rec(2)]));
  assert.equal(out.ok, true);
  assert.equal(out.shown, 1);
  assert.equal(out.skipped, hostile.length);
  assert.ok(out.lines[0].includes('T2'));
});

test('view: frozen inputs are never mutated', () => {
  const records = Object.freeze([Object.freeze(rec(1)), Object.freeze(rec(2))]);
  const out = shape(records);
  assert.equal(out.shown, 2);
  assert.equal(records[0].title, 'T1');
  assert.equal(records[1].read, false);
});

test('view: hostile markup passes through verbatim as plain text, never interpreted or escaped', () => {
  const title = '<script>alert(1)</script>';
  const body = '<img src=x onerror=alert(2)> & "quotes"';
  const out = shape([rec(1, { title, body })]);
  assert.equal(out.shown, 1);
  assert.ok(out.lines[0].includes(title));
  assert.ok(out.lines[0].includes(body));
  assert.equal(out.lines[0].includes('&amp;'), false);
});

test('view: empty and non-array inputs are clean no-ops', () => {
  const empty = shape([]);
  assert.deepEqual(empty, { ok: true, lines: [], shown: 0, skipped: 0, hidden: 0, total: 0 });
  for (const bad of [null, 'x', 42, {}]) {
    const out = shape(bad);
    assert.equal(out.ok, true);
    assert.equal(out.shown, 0);
  }
});

test('view: read records are marked and priority tags render', () => {
  const out = shape([rec(1, { read: true, priority: 'high' }), rec(2, { priority: 'low' })]);
  // display is newest first, so the later record leads
  assert.ok(out.lines[0].startsWith('[low] T2'));
  assert.ok(out.lines[1].includes('(read) [high] T1'));
  const normal = shape([rec(3)]);
  assert.ok(normal.lines[0].startsWith('T3'));
});

test('view: end to end over REAL desk records, raw and channel-clipped alike', () => {
  const desk = createNotificationDesk({ clock: () => 1000 });
  assert.equal(desk.create({ title: 'Short', body: 'y'.repeat(500), priority: 'high' }).ok, true);
  assert.equal(desk.create({ title: 'Second', body: 'plain body', priority: 'normal' }).ok, true);
  const raw = shape(desk.list());
  assert.equal(raw.shown, 2);
  assert.ok(raw.lines[0].includes('Second'));
  // the read surface clips strings at 200; both shapes must display
  const clipped = shape(desk.list().map((r) => Object.assign({}, r, { body: r.body.slice(0, 200) })));
  assert.equal(clipped.shown, 2);
  assert.equal(clipped.lines.length, 2);
});

test('panel: the renderer file stays free of markup-setting surfaces and mutation paths', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent-panel.js'), 'utf8');
  // strip comments so the documented prohibitions in the header do not
  // trip the scan; only real code is checked
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (l.includes('://') ? l : l.replace(/\/\/.*$/, '')))
    .join('\n');
  for (const banned of [/innerHTML\s*=/, /\.innerHTML/, /outerHTML/, /document\.write/, /eval\s*\(/, /insertAdjacentHTML/, /srcdoc/]) {
    assert.equal(banned.test(src), false, 'panel code must not match ' + banned);
  }
  assert.ok(src.includes('textContent'));
  // the panel's only write-ish path is the explicit id-only acknowledge
  // gesture (blueprint 3j.5): notifications_ack, called only from the
  // button's click listener. No markRead, no run/approval/grant/
  // persistence references, and nothing sends data back from a read.
  for (const banned of ['markRead', 'run_start', 'run:step', 'approval', 'grants', 'persistence']) {
    assert.equal(src.toLowerCase().includes(banned.toLowerCase()), false, 'panel code must not reference ' + banned);
  }
  // The word acknowledge appears only as button labels/state text; the
  // single channel reference is the notifications_ack request.
  assert.equal(src.split('notifications_ack').length - 1, 2, 'guard plus the one id-only call');
  assert.ok(src.includes("notifications_ack({ id: n.id })"), 'the request is id-only');
  for (const banned of ['acknowledg(', 'acknowledgement(', 'markread']) {
    assert.equal(src.toLowerCase().includes(banned.toLowerCase()), false, 'panel code must not reference ' + banned);
  }
});

test('index.html: the view script is included before the panel and the CSP is unchanged', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const viewIdx = html.indexOf('agent-notifications-view.js');
  const panelIdx = html.indexOf('agent-panel.js');
  assert.ok(viewIdx !== -1);
  assert.ok(panelIdx !== -1);
  assert.ok(viewIdx < panelIdx);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("connect-src 'none'"));
});

test('view: the shaper exposes no write, scheduling or delivery surface', () => {
  const view = require('../src/agent-notifications-view');
  for (const key of Object.keys(view)) {
    assert.equal(['shape', 'MAX_DISPLAY'].includes(key), true, 'unexpected export ' + key);
  }
});
