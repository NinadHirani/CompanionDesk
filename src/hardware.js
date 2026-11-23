'use strict';

// Hardware profile: what kind of machine CompanionDesk runs on, used to pick
// the DEFAULT local models and to show a recommendation in Settings.
//
// Strictly local and read-only: no shell commands, no files, no network, no
// telemetry. The desktop main process reads the operating system's own APIs
// (total/free memory, logical CPU count, platform, architecture). The web
// build reads the browser's coarse hints and always labels them approximate:
// navigator.deviceMemory is a rounded-down bucket, never an exact reading.
// GPU and NPU stay unknown unless a safe built-in API reports them; nothing
// here guesses.
//
// Renderer surfaces only ever receive sanitized facts (see sanitizeHardware):
// no exact byte counts, no CPU architecture, no free-memory reading, so the
// settings view cannot become a device fingerprint.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionHardware = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GIB = 1024 * 1024 * 1024;
  // Far above any real machine's RAM or core count; beyond this a reading is
  // malformed, not "a big computer".
  const MAX_BYTES = 1e12;
  const MAX_CORES = 4096;

  // Thresholds, documented and conservative for local LLM use:
  //   powerful:    >= 16 GiB memory AND >= 8 logical cores
  //   balanced:    >= 8 GiB memory  AND >= 4 logical cores
  //   lightweight: everything else
  // Total (not free) memory is the basis: free memory swings with whatever
  // else is running, and the profile should stay stable for a session. Any
  // missing, unknown or malformed reading fails the tier it is needed for,
  // so an unknown machine always lands on lightweight.
  const THRESHOLDS = Object.freeze({
    powerful: Object.freeze({ memoryGib: 16, logicalCores: 8 }),
    balanced: Object.freeze({ memoryGib: 8, logicalCores: 4 }),
  });
  const PROFILES = Object.freeze(['lightweight', 'balanced', 'powerful']);

  function finiteNonNegative(value, cap) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > cap) return null;
    return value;
  }

  function classifyProfile({ totalMemoryBytes, logicalCores } = {}) {
    const bytes = finiteNonNegative(totalMemoryBytes, MAX_BYTES);
    const cores = finiteNonNegative(logicalCores, MAX_CORES);
    const gib = bytes === null ? null : bytes / GIB;
    if (gib !== null && cores !== null) {
      if (gib >= THRESHOLDS.powerful.memoryGib && cores >= THRESHOLDS.powerful.logicalCores) return 'powerful';
      if (gib >= THRESHOLDS.balanced.memoryGib && cores >= THRESHOLDS.balanced.logicalCores) return 'balanced';
    }
    return 'lightweight';
  }

  function readNumber(fn) {
    try {
      const v = typeof fn === 'function' ? fn() : null;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  // Desktop main process only. Plain Node OS APIs; nothing is executed or
  // probed beyond them.
  function detectNodeHardware(os) {
    if (!os) return null;
    return {
      source: 'node_os',
      totalMemoryBytes: readNumber(() => os.totalmem && os.totalmem()),
      freeMemoryBytes: readNumber(() => os.freemem && os.freemem()),
      logicalCores: readNumber(() => (Array.isArray(os.cpus && os.cpus()) ? os.cpus().length : null)),
      platform: typeof os.platform === 'function' ? os.platform() : null,
      arch: typeof os.arch === 'function' ? os.arch() : null,
      gpu: null, // not exposed by a safe built-in API; stays unknown
      npu: null,
    };
  }

  // Web/mobile: the browser's own coarse hints. deviceMemory is a floor
  // bucket (rounded DOWN to 1/2/4/8 GB) and may be absent entirely;
  // hardwareConcurrency is the thread count the browser chooses to expose.
  // Both are reported as approximations, never as exact readings.
  function detectWebHardware(nav) {
    // An explicit null means "none available" (tests, embedded builds); only
    // an omitted argument falls back to the real global navigator.
    const n = nav === undefined ? (typeof navigator !== 'undefined' ? navigator : null) : nav;
    if (!n) return null;
    const gb = typeof n.deviceMemory === 'number' && Number.isFinite(n.deviceMemory) && n.deviceMemory > 0
      ? n.deviceMemory : null;
    const cores = typeof n.hardwareConcurrency === 'number' && Number.isFinite(n.hardwareConcurrency) && n.hardwareConcurrency > 0
      ? Math.floor(n.hardwareConcurrency) : null;
    let platform = 'web';
    if (n.userAgentData && typeof n.userAgentData.platform === 'string' && n.userAgentData.platform) {
      platform = n.userAgentData.platform.toLowerCase();
    }
    return {
      source: 'web_api',
      memoryApproxGb: gb,
      memoryExact: false, // a browser never gives exact memory; never pretend
      logicalCores: cores,
      platform,
      gpu: null,
      npu: null,
    };
  }

  function classifyWebHardware(raw) {
    if (!raw) return 'lightweight';
    return classifyProfile({
      totalMemoryBytes: raw.memoryApproxGb === null || raw.memoryApproxGb === undefined ? null : raw.memoryApproxGb * GIB,
      logicalCores: raw.logicalCores,
    });
  }

  const PLATFORM_LABELS = Object.freeze({ darwin: 'mac', win32: 'windows', linux: 'linux', android: 'android' });

  function memoryFacts(raw) {
    if (raw.source === 'web_api') {
      const gb = raw.memoryApproxGb;
      if (gb === null || gb === undefined) return { memoryLabel: 'unknown', memoryTier: 'unknown', memoryExact: false };
      return {
        memoryLabel: `about ${gb} GB (approximate)`,
        memoryTier: gb >= 8 ? 'high' : gb >= 4 ? 'moderate' : 'low',
        memoryExact: false,
      };
    }
    const bytes = finiteNonNegative(raw.totalMemoryBytes, MAX_BYTES);
    if (bytes === null) return { memoryLabel: 'unknown', memoryTier: 'unknown', memoryExact: true };
    const gib = bytes / GIB;
    if (gib < 2) return { memoryLabel: 'under 2 GB', memoryTier: 'low', memoryExact: true };
    if (gib > 32) return { memoryLabel: '32 GB or more', memoryTier: 'high', memoryExact: true };
    const n = Math.max(2, Math.round(gib / 2) * 2);
    return {
      memoryLabel: `about ${n} GB`,
      memoryTier: gib >= 8 ? 'high' : gib >= 4 ? 'moderate' : 'low',
      memoryExact: true,
    };
  }

  function coresFacts(cores) {
    const c = finiteNonNegative(cores, MAX_CORES);
    if (c === null || c === 0) return 'unknown';
    if (c <= 4) return 'low';
    if (c <= 8) return 'medium';
    return 'high';
  }

  function platformLabel(raw) {
    const p = String(raw.platform || '').toLowerCase();
    if (raw.source === 'web_api') {
      if (p === 'macos' || p === 'mac') return 'mac';
      if (p === 'windows') return 'windows';
      if (p === 'linux') return 'linux';
      if (p === 'android') return 'android';
      return 'web';
    }
    return PLATFORM_LABELS[p] || 'unknown';
  }

  // The only shape a renderer ever sees. Keys are fixed: no exact byte
  // counts, no architecture string, no free-memory reading.
  function sanitizeHardware(raw) {
    if (!raw || (raw.source !== 'node_os' && raw.source !== 'web_api')) {
      return {
        source: 'unknown', memoryLabel: 'unknown', memoryExact: false,
        memoryTier: 'unknown', coresTier: 'unknown', platformLabel: 'unknown',
        gpu: null, npu: null, profile: 'lightweight',
      };
    }
    return {
      source: raw.source,
      ...memoryFacts(raw),
      coresTier: coresFacts(raw.logicalCores),
      platformLabel: platformLabel(raw),
      gpu: null,
      npu: null,
      profile: raw.source === 'web_api' ? classifyWebHardware(raw)
        : classifyProfile({ totalMemoryBytes: raw.totalMemoryBytes, logicalCores: raw.logicalCores }),
    };
  }

  // setting 'auto' (or unset) uses the detected tier; an explicit valid
  // profile wins; anything invalid falls back conservative.
  function resolveProfile(setting, classified) {
    if (typeof setting === 'string' && PROFILES.includes(setting)) return setting;
    return PROFILES.includes(classified) ? classified : 'lightweight';
  }

  return { PROFILES, THRESHOLDS, classifyProfile, classifyWebHardware, detectNodeHardware, detectWebHardware, sanitizeHardware, resolveProfile };
});
