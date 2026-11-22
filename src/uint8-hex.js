'use strict';

// Tiny compatibility shim for pdf.js (ES2025 Uint8Array hex/base64 helpers).
// Newer Chromium/V8 ships Uint8Array.prototype.toHex/toBase64; older Electron
// main processes, Chromium-based webviews and current Node LTS do not. The
// shim installs itself and is a no-op where the methods already exist.

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
  return true;
}

installUint8ArrayCoders();

if (typeof module === 'object' && module.exports) module.exports = { installUint8ArrayCoders };
