'use strict';

// Gate 2 slice 1: deterministic digests shared by the approval and audit
// modules. Pure: no fs, no network, no timers, no model.
//
// canonicalJson serializes a value with object keys sorted at every level, so
// the same logical argument set always produces the same byte string no
// matter what order the caller built it in. sha256Hex is a self-contained
// FIPS 180-4 SHA-256 so these modules never need a crypto dependency in
// either the Node or the web build.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionDigest = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Accepts only plain JSON-like data: null, finite numbers, booleans,
  // strings, DENSE arrays (every index an own enumerable data property, no
  // extra properties, no symbols, no accessors) and plain objects (prototype
  // Object.prototype or null, only own ENUMERABLE DATA properties, no symbol
  // keys, no non-enumerable properties, no getters/setters). Anything else
  // returns a short reason string; null means the value is clean. Digesting
  // such a value can therefore never execute a getter, never see a hidden
  // or symbol-keyed property, and never collapse two different structures
  // (a sparse array and its dense counterpart are distinct values).
  // Recursion is bounded two ways so this function always terminates with a
  // reason instead of overflowing the stack: ancestors tracks the current
  // path (a value reached again through itself is circular) and depth caps
  // path length. A shared-but-acyclic reference (a DAG) is legal and still
  // digests: ancestors tracks only the current path.
  const MAX_DEPTH = 256;

  function plainDataProblem(value, ancestors, depth) {
    if (ancestors === undefined) ancestors = new Set();
    if (depth === undefined) depth = 0;
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return null;
    if (t === 'number') return Number.isFinite(value) ? null : 'non_finite_number';
    if (Array.isArray(value)) {
      if (ancestors.has(value)) return 'circular';
      if (depth >= MAX_DEPTH) return 'too_deep';
      const keys = Object.keys(value);
      if (keys.length !== value.length) return 'sparse_or_extra_array_keys';
      for (let i = 0; i < value.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) return 'sparse_array';
        const d = Object.getOwnPropertyDescriptor(value, i);
        if (d.get !== undefined || d.set !== undefined) return 'accessor_property';
      }
      if (Object.getOwnPropertySymbols(value).length > 0) return 'symbol_key';
      ancestors.add(value);
      for (const e of value) {
        const p = plainDataProblem(e, ancestors, depth + 1);
        if (p) { ancestors.delete(value); return p; }
      }
      ancestors.delete(value);
      return null;
    }
    if (t !== 'object') return 'unsupported_type';
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return 'not_plain_object';
    if (ancestors.has(value)) return 'circular';
    if (depth >= MAX_DEPTH) return 'too_deep';
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length !== Object.keys(value).length) return 'non_enumerable_property';
    if (Object.getOwnPropertySymbols(value).length > 0) return 'symbol_key';
    for (const k of ownNames) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (d.get !== undefined || d.set !== undefined) return 'accessor_property';
      ancestors.add(value);
      const p = plainDataProblem(value[k], ancestors, depth + 1);
      ancestors.delete(value);
      if (p) return p;
    }
    return null;
  }

  function canonicalJson(value) {
    const problem = plainDataProblem(value);
    if (problem) throw new TypeError('canonicalJson: ' + problem);
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return Object.is(value, -0) ? '-0' : String(value);
    }
    if (t === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (t !== 'object') throw new TypeError('canonicalJson: unsupported type ' + t);
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }

  // FIPS 180-4 constants.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256OfBytes(bytes) {
    const len = bytes.length;
    const bitLenHi = Math.floor((len / 0x20000000)) >>> 0; // (len*8) / 2^32
    const bitLenLo = (len << 3) >>> 0;
    const padded = new Uint8Array((((len + 9) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenHi);
    dv.setUint32(padded.length - 4, bitLenLo);
    const w = new Uint32Array(64);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (let i = 0; i < padded.length; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
      for (let j = 16; j < 64; j++) {
        const w15 = w[j - 15], w2 = w[j - 2];
        const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let j = 0; j < 64; j++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, idx) => odv.setUint32(idx * 4, x));
    return out;
  }

  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  function sha256Hex(text) {
    if (typeof text !== 'string') throw new TypeError('sha256Hex: expects a string');
    return toHex(sha256OfBytes(new TextEncoder().encode(text)));
  }

  return { canonicalJson, sha256Hex, plainDataProblem };
});
