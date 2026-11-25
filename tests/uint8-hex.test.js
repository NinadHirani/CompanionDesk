'use strict';

// The uint8-hex shim backs the ES2025 typed-array coders the bundled pdf.js
// uses. This regression pins the static Uint8Array.fromBase64, which pdf.js's
// decompressSignature calls unguarded and which Node LTS and older Electron
// main processes do not ship.

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

require('../src/uint8-hex');

const eqBytes = (actual, expected) =>
  assert.deepEqual(Array.from(actual), Array.from(expected));
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const shimSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'uint8-hex.js'), 'utf8');

test('REGRESSION: the shim installs the static Uint8Array.fromBase64 pdf.js calls', () => {
  assert.equal(typeof Uint8Array.fromBase64, 'function');
  eqBytes(Uint8Array.fromBase64('SGVsbG8='), bytesOf('Hello'));
  eqBytes(Uint8Array.fromBase64('SGVsbG8'), bytesOf('Hello')); // unpadded, loose
  eqBytes(Uint8Array.fromBase64('SGVs bG8='), bytesOf('Hello')); // whitespace skipped
  eqBytes(Uint8Array.fromBase64(''), new Uint8Array(0));
  eqBytes(Uint8Array.fromBase64('_w==', { alphabet: 'base64url' }), [255]);
  eqBytes(Uint8Array.fromBase64('-w==', { alphabet: 'base64url' }), [251]);
});

test('fromBase64 roundtrips toBase64 across lengths, including the 0x8000 chunk edge', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33, 32767, 32768, 32769, 70000]) {
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = (i * 37 + 11) & 0xff;
    eqBytes(Uint8Array.fromBase64(u8.toBase64()), u8);
  }
});

test('fromBase64 rejects malformed input like the spec decoder', () => {
  assert.throws(() => Uint8Array.fromBase64('A'), SyntaxError);        // lone quantum char
  assert.throws(() => Uint8Array.fromBase64('A='), SyntaxError);       // one real char
  assert.throws(() => Uint8Array.fromBase64('AB='), SyntaxError);      // dangling single pad
  assert.throws(() => Uint8Array.fromBase64('AB=C'), SyntaxError);     // pad before the end
  assert.throws(() => Uint8Array.fromBase64('AB==CD'), SyntaxError);   // pad outside the final group
  assert.throws(() => Uint8Array.fromBase64('SGVs!G8='), SyntaxError); // invalid character
  assert.throws(() => Uint8Array.fromBase64('ok', { alphabet: 'nope' }), TypeError);
});

test('the shim is a no-op where the prototype methods already exist', () => {
  class FakeU8 {}
  FakeU8.prototype.toHex = () => 'native';
  const sandbox = { Uint8Array: FakeU8, module: { exports: {} } };
  vm.runInNewContext(shimSrc, sandbox);
  assert.equal(sandbox.module.exports.installUint8ArrayCoders(), false);
  assert.equal(typeof FakeU8.prototype.toBase64, 'undefined');
  assert.equal(FakeU8.prototype.toHex(), 'native');
});

test('the shim installs all three coders on a bare Uint8Array', () => {
  class BareU8 {}
  const sandbox = { Uint8Array: BareU8, module: { exports: {} } };
  vm.runInNewContext(shimSrc, sandbox);
  assert.equal(typeof BareU8.prototype.toHex, 'function');
  assert.equal(typeof BareU8.prototype.toBase64, 'function');
  assert.equal(typeof BareU8.fromBase64, 'function');
});
