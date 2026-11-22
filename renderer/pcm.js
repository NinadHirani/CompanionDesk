'use strict';

// Audio conversion for the recorder. Dual-mode (plain script in the page,
// require() in tests). The recorder hands over Float32 samples in -1..1; the
// transcriber wants 16-bit little-endian PCM bytes.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionPcm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Float32Array[] (chunks) -> Uint8Array of Int16 little-endian samples.
  function floatChunksToPcm16(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new DataView(new ArrayBuffer(total * 2));
    let i = 0;
    for (const chunk of chunks) {
      for (let k = 0; k < chunk.length; k++, i++) {
        const s = Math.max(-1, Math.min(1, Number.isFinite(chunk[k]) ? chunk[k] : 0));
        out.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      }
    }
    return new Uint8Array(out.buffer);
  }

  return { floatChunksToPcm16 };
});
