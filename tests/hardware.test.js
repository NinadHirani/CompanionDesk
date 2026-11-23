'use strict';

// M1 slice 3: local hardware detection and profiles. Every test here pins
// the guarantees that matter: thresholds, conservative behavior on unknown
// or malformed readings, sanitized renderer output with no fingerprint, and
// a profile that steers only DEFAULT models while explicit choices always
// win. Detection itself is local-only: the OS/browser APIs read here never
// touch the network.

const test = require('node:test');
const assert = require('node:assert');
const HW = require('../src/hardware');
const MS = require('../src/model-selection');
const { DEFAULTS, normalizeSettings, validatePatch } = require('../src/settings');

const GIB = 1024 * 1024 * 1024;

test('thresholds place real machines on sensible tiers', () => {
  const c = (gib, cores) => HW.classifyProfile({ totalMemoryBytes: gib * GIB, logicalCores: cores });
  assert.equal(c(16, 8), 'powerful');
  assert.equal(c(32, 12), 'powerful');
  assert.equal(c(16 - 1 / GIB, 8), 'balanced'); // one byte under 16 GiB
  assert.equal(c(16, 7), 'balanced'); // cores gate the higher tier
  assert.equal(c(8, 4), 'balanced');
  assert.equal(c(12, 6), 'balanced');
  assert.equal(c(8 - 1 / GIB, 4), 'lightweight'); // one byte under 8 GiB
  assert.equal(c(4, 8), 'lightweight'); // memory gates the tier
  assert.equal(c(32, 2), 'lightweight');
});

test('unknown or missing readings are conservative', () => {
  assert.equal(HW.classifyProfile({}), 'lightweight');
  assert.equal(HW.classifyProfile({ totalMemoryBytes: 32 * GIB }), 'lightweight'); // cores unknown
  assert.equal(HW.classifyProfile({ logicalCores: 16 }), 'lightweight'); // memory unknown
  assert.equal(HW.classifyProfile(), 'lightweight');
});

test('malformed values never throw and stay conservative', () => {
  for (const bad of [NaN, -1, '16', Infinity, null, [16], true]) {
    assert.equal(HW.classifyProfile({ totalMemoryBytes: bad, logicalCores: bad }), 'lightweight');
  }
  // Beyond any real machine is malformed, not "a big computer".
  assert.equal(HW.classifyProfile({ totalMemoryBytes: Number.MAX_SAFE_INTEGER, logicalCores: 8 }), 'lightweight');
});

test('desktop detection reads only the OS APIs; arch never leaves the main process', () => {
  const fakeOs = {
    totalmem: () => 16 * GIB,
    freemem: () => 8 * GIB,
    cpus: () => new Array(8).fill(0),
    platform: () => 'darwin',
    arch: () => 'arm64',
  };
  const raw = HW.detectNodeHardware(fakeOs);
  assert.equal(raw.source, 'node_os');
  assert.equal(raw.totalMemoryBytes, 16 * GIB);
  assert.equal(raw.arch, 'arm64'); // kept in the main process only
  assert.equal(HW.classifyProfile(raw), 'powerful');
  const broken = HW.detectNodeHardware({}); // an OS object missing every API
  assert.equal(broken.totalMemoryBytes, null);
  assert.equal(broken.logicalCores, null);
  assert.equal(HW.classifyProfile(broken), 'lightweight');
  assert.equal(HW.detectNodeHardware(null), null);
});

test('web detection is always approximate, never exact', () => {
  const raw = HW.detectWebHardware({ deviceMemory: 8, hardwareConcurrency: 8, userAgentData: { platform: 'Android' } });
  assert.equal(raw.source, 'web_api');
  assert.equal(raw.memoryExact, false);
  assert.equal(raw.memoryApproxGb, 8);
  assert.equal(HW.classifyWebHardware(raw), 'balanced');
  const bare = HW.detectWebHardware({}); // hints absent entirely
  assert.equal(bare.memoryApproxGb, null);
  assert.equal(bare.memoryExact, false);
  assert.equal(HW.classifyWebHardware(bare), 'lightweight');
  assert.equal(HW.detectWebHardware(null), null);
});

test('sanitized facts carry no fingerprint', () => {
  const raw = HW.detectNodeHardware({
    totalmem: () => 8 * GIB + 1234567,
    freemem: () => 4 * GIB + 987,
    cpus: () => new Array(8).fill(0),
    platform: () => 'darwin',
    arch: () => 'arm64',
  });
  const s = HW.sanitizeHardware(raw);
  assert.deepEqual(Object.keys(s).sort(), ['coresTier', 'gpu', 'memoryExact', 'memoryLabel', 'memoryTier', 'npu', 'platformLabel', 'profile', 'source']);
  assert.equal(s.memoryLabel, 'about 8 GB'); // bucketed, never the exact bytes
  assert.equal(s.platformLabel, 'mac');
  assert.equal(s.profile, 'balanced');
  const flat = JSON.stringify(s);
  assert.ok(!flat.includes('1234567'), 'exact bytes leak');
  assert.ok(!flat.includes('arm64'), 'arch leaks');
  assert.ok(!flat.includes(String(4 * GIB + 987)), 'free memory leaks');
  const unknown = HW.sanitizeHardware(null);
  assert.equal(unknown.profile, 'lightweight');
  assert.equal(unknown.memoryLabel, 'unknown');
});

test('web facts are labelled approximate in the sanitized shape', () => {
  const web = HW.sanitizeHardware(HW.detectWebHardware({ deviceMemory: 8, hardwareConcurrency: 8 }));
  assert.equal(web.memoryExact, false);
  assert.equal(web.memoryLabel, 'about 8 GB (approximate)');
  const bare = HW.sanitizeHardware(HW.detectWebHardware({}));
  assert.equal(bare.memoryLabel, 'unknown');
});

test('platform differences map to coarse labels', () => {
  const fake = (platform) => HW.sanitizeHardware({ source: 'node_os', totalMemoryBytes: 8 * GIB, logicalCores: 4, platform, arch: 'x64' });
  assert.equal(fake('win32').platformLabel, 'windows');
  assert.equal(fake('linux').platformLabel, 'linux');
  assert.equal(fake('android').platformLabel, 'android');
  assert.equal(fake('sunos').platformLabel, 'unknown');
  const web = HW.sanitizeHardware(HW.detectWebHardware({ deviceMemory: 4, hardwareConcurrency: 4, userAgentData: { platform: 'macOS' } }));
  assert.equal(web.platformLabel, 'mac');
  const webBare = HW.sanitizeHardware(HW.detectWebHardware({ deviceMemory: 4, hardwareConcurrency: 4 }));
  assert.equal(webBare.platformLabel, 'web');
});

test('profile resolution: explicit choice wins, garbage falls conservative', () => {
  assert.equal(HW.resolveProfile('powerful', 'balanced'), 'powerful');
  assert.equal(HW.resolveProfile('auto', 'balanced'), 'balanced');
  assert.equal(HW.resolveProfile(undefined, 'balanced'), 'balanced');
  // An invalid stored setting cannot happen through the validated enum;
  // defensively it falls back to the DETECTED tier (itself conservative),
  // never to a made-up profile.
  assert.equal(HW.resolveProfile('turbo', 'balanced'), 'balanced');
  assert.equal(HW.resolveProfile('auto', 'nonsense'), 'lightweight');
});

test('recommendations only name installed models; nothing is pulled', () => {
  assert.deepEqual(MS.recommendedForProfile('balanced', ['llama3.2:latest', 'gemma3:4b']), { chat: 'llama3.2:latest', vision: 'gemma3:4b' });
  assert.deepEqual(MS.recommendedForProfile('powerful', ['llama3.2:latest']), { chat: null, vision: null }); // gemma3 not installed
  assert.deepEqual(MS.recommendedForProfile('powerful', ['llama3.2:latest', 'gemma3:4b']), { chat: 'gemma3:4b', vision: 'gemma3:4b' });
  assert.deepEqual(MS.recommendedForProfile('lightweight', ['llama3.2:latest', 'gemma3:4b']), { chat: 'llama3.2:latest', vision: null });
  assert.equal(MS.recommendedForProfile('powerful', null), null); // Ollama unreachable: no recommendation invented
  assert.deepEqual(MS.recommendedForProfile('nonsense', ['llama3.2:latest']), { chat: 'llama3.2:latest', vision: null });
});

test('profile fallback changes only the unconfigured default; explicit choices always win', () => {
  assert.equal(MS.chatFallbackForProfile('powerful'), 'gemma3:4b');
  assert.equal(MS.chatFallbackForProfile('balanced'), 'llama3.2:latest');
  assert.equal(MS.chatFallbackForProfile('lightweight'), 'llama3.2:latest');
  assert.equal(MS.chatFallbackForProfile('garbage'), 'llama3.2:latest');
  const picked = MS.resolveChatModel({ configured: 'llama3.2:latest', fallback: 'gemma3:4b', installed: ['llama3.2:latest', 'gemma3:4b'] });
  assert.equal(picked.model, 'llama3.2:latest');
  assert.equal(picked.resolved, 'configured');
});

test('the hardware profile is a validated enum setting', () => {
  assert.equal(DEFAULTS.hardware_profile, 'auto');
  assert.equal(normalizeSettings({}).hardware_profile, 'auto');
  assert.equal(normalizeSettings({ hardware_profile: 'turbo' }).hardware_profile, 'auto'); // garbage falls back
  const ok = validatePatch({ hardware_profile: 'balanced' });
  assert.ok(ok.ok);
  assert.equal(ok.clean.hardware_profile, 'balanced');
  const bad = validatePatch({ hardware_profile: 'turbo' });
  assert.ok(!bad.ok);
});
