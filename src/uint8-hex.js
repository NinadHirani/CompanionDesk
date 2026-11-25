'use strict';

// Tiny compatibility shim for pdf.js (ES2025 Uint8Array hex/base64 helpers).
// Newer Chromium/V8 ships Uint8Array.prototype.toHex/toBase64 plus the
// static Uint8Array.fromBase64; older Electron main processes,
// Chromium-based webviews and current Node LTS do not. The shim installs
// itself and is a no-op where the methods already exist. The static matters:
// the bundled pdf.js calls Uint8Array.fromBase64 unguarded in
// decompressSignature (signed-PDF rendering), so without it that path throws
// on exactly the runtimes this shim exists for.

function installUint8ArrayCoders() {
  if (typeof Uint8Array === 'undefined' || Uint8Array.prototype.toHex) return false;
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value: function toHex() {
      let s = '';
      for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0');
      return s;
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value: function toBase64() {
      const chunk = 0x8000;
      let s = '';
      for (let i = 0; i < this.length; i += chunk) {
        s += String.fromCharCode.apply(null, this.subarray(i, i + chunk));
      }
      return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
    },
    writable: true,
    configurable: true,
  });
  // Static decoder. pdf.js's decompressSignature calls Uint8Array.fromBase64
  // unguarded; ship the spec-shaped loose decoder (default alphabet, optional
  // base64url, whitespace skipped, missing or present padding, strict-length
  // errors) rather than leaving a TypeError for the caller's catch block.
  if (typeof Uint8Array.fromBase64 !== 'function') {
    const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const decode = function fromBase64(input, options) {
      const alphabet = options && options.alphabet !== undefined ? options.alphabet : 'base64';
      if (alphabet !== 'base64' && alphabet !== 'base64url') {
        throw new TypeError('Invalid alphabet: ' + String(alphabet));
      }
      const chars = alphabet === 'base64url' ? URL : STD;
      const t = new Int8Array(128).fill(-1);
      for (let i = 0; i < 64; i++) t[chars.charCodeAt(i)] = i;
      const text = String(input);
      let s = '';
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) continue; // ASCII whitespace
        s += text[i];
      }
      const n = s.length;
      const out = new Uint8Array(Math.floor((n + 3) / 4) * 3); // allocation upper bound
      let written = 0;
      let i = 0;
      while (i < n) {
        const group = s.slice(i, i + 4);
        const isLast = i + group.length >= n;
        i += group.length;
        let pad = 0;
        while (pad < group.length && group[group.length - 1 - pad] === '=') pad++;
        const real = group.length - pad;
        if (real < 2) throw new SyntaxError('invalid base64 quantum');
        if (pad > 0 && (!isLast || group.length !== 4 || pad > 2)) {
          throw new SyntaxError('invalid base64 padding');
        }
        let bits = 0;
        for (let k = 0; k < real; k++) {
          const code = group.charCodeAt(k);
          const v = code < 128 ? t[code] : -1;
          if (v < 0) throw new SyntaxError('invalid base64 character');
          bits = (bits << 6) | v;
        }
        if (real === 2) {
          out[written++] = (bits >> 4) & 0xff;
        } else if (real === 3) {
          out[written++] = (bits >> 10) & 0xff;
          out[written++] = (bits >> 2) & 0xff;
        } else {
          out[written++] = (bits >> 16) & 0xff;
          out[written++] = (bits >> 8) & 0xff;
          out[written++] = bits & 0xff;
        }
      }
      return out.slice(0, written);
    };
    Object.defineProperty(Uint8Array, 'fromBase64', {
      value: decode,
      writable: true,
      configurable: true,
    });
  }

  return true;
}

installUint8ArrayCoders();

if (typeof module === 'object' && module.exports) module.exports = { installUint8ArrayCoders };
