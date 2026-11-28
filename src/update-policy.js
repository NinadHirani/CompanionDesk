'use strict';

// Pure decision logic for updates. Nothing here touches Electron or the
// network, so it can be tested directly. The controller in src/updater.js
// calls these functions and turns the answers into real behaviour; the
// renderer only renders what the controller sends it.

// The three ways an installed app can receive an update:
//   disabled         not an installed app (development build): do nothing
//   auto             in-app download and in-app install are both allowed
//   manual-download  check for updates, then open the download page; never
//                    install inside the app
const UPDATE_MODES = Object.freeze(['disabled', 'auto', 'manual-download']);

// macOS background auto-update is provided by Squirrel.Mac, which refuses to
// replace an app whose code signature is missing or invalid. So an app built
// with electron-builder's identity: null can only offer the manual route,
// whatever we wish were true. identity set at build time means a Developer ID
// certificate signed the app and Squirrel can do its job.
const MAC_SIGNING_VALUES = Object.freeze(['unsigned', 'developer-id']);

function macSigningFromBuildConfig(identity) {
  return identity === null || identity === undefined ? 'unsigned' : 'developer-id';
}

// The updater is wired for the three desktop Electron platforms only.
// Anything else (an Android/Capacitor shell, an unknown platform) must
// fail closed: it must never reach the Windows/Linux branch and be
// offered an in-app auto-update that cannot work there.
const SUPPORTED_UPDATE_PLATFORMS = ['darwin', 'win32', 'linux'];

function modeFor({ platform, isPackaged, macSigning }) {
  if (!isPackaged) {
    return {
      mode: 'disabled',
      canCheck: false,
      canDownload: false,
      canInstallInApp: false,
      openDownloadPage: false,
      reason: 'Development build. Updates apply only to installed apps.',
    };
  }
  if (platform === 'darwin') {
    if (macSigning === 'developer-id') {
      return {
        mode: 'auto',
        canCheck: true,
        canDownload: true,
        canInstallInApp: true,
        openDownloadPage: true,
        reason: null,
      };
    }
    return {
      mode: 'manual-download',
      canCheck: true,
      canDownload: false,
      canInstallInApp: false,
      openDownloadPage: true,
      reason:
        'This Mac build is not code-signed, so macOS will not let an app replace itself in place. ' +
        'New versions arrive as a download you install by hand.',
    };
  }
  if (!SUPPORTED_UPDATE_PLATFORMS.includes(platform)) {
    return {
      mode: 'disabled',
      canCheck: false,
      canDownload: false,
      canInstallInApp: false,
      openDownloadPage: false,
      reason: 'Updates are not wired for this platform yet. New versions arrive from the project releases page.',
    };
  }
  // Windows (NSIS) and Linux (AppImage) verify update integrity with the
  // sha512 checksum in the update feed; an in-app install is fine unsigned.
  return {
    mode: 'auto',
    canCheck: true,
    canDownload: true,
    canInstallInApp: true,
    openDownloadPage: true,
    reason: null,
  };
}

function resolveChannel(setting) {
  return setting === 'continuous' ? 'continuous' : 'stable';
}

// electron-updater's rule, made explicit for tests: a build on a prerelease
// version follows prereleases; a stable build stays on stable releases.
function allowPrereleaseFor({ appVersion, channel }) {
  return channel === 'continuous' || hasPrerelease(appVersion);
}

function hasPrerelease(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.pre.length > 0;
}

// --- semver comparison (the subset electron-updater needs, spelled out so the
// --- sanity check in the UI is testable without electron-updater) ---

// electron-updater validates feed versions with the semver package, so
// this parser must accept exactly what semver accepts. semver rejects
// leading zeros in the core numbers and in numeric prerelease
// identifiers, and empty identifiers; accepting any of those here could
// declare an update "available" that the updater can never install.
const PRERELEASE_ID = /^(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)$/;

function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
  if (!m) return null;
  const pre = m[4] === undefined ? [] : m[4].split('.');
  if (pre.some((id) => !PRERELEASE_ID.test(id))) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

function comparePrereleaseIdentifier(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a !== '' && !Number.isNaN(na);
  const bNum = b !== '' && !Number.isNaN(nb);
  if (aNum && bNum) return na === nb ? 0 : na < nb ? -1 : 1;
  if (aNum) return -1; // numeric identifiers have lower precedence
  if (bNum) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va === null || vb === null) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1; // release outranks any prerelease
  if (vb.pre.length === 0) return -1;
  const len = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < len; i++) {
    if (va.pre[i] === undefined) return -1; // fewer identifiers is lower
    if (vb.pre[i] === undefined) return 1;
    const c = comparePrereleaseIdentifier(va.pre[i], vb.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function isNewerVersion(current, candidate) {
  const c = compareVersions(candidate, current);
  return c !== null && c > 0;
}

// --- user-facing strings and the one action the banner may offer ---

function describeState(state) {
  // state: { phase, version?, progress?, error? } plus the mode fields.
  const { mode, phase } = state;
  if (mode === 'disabled') return { text: null, action: null };
  switch (phase) {
    case 'checking':
      return { text: 'Checking for updates…', action: null };
    case 'none':
      return { text: `CompanionDesk ${state.appVersion} is up to date.`, action: null };
    case 'available':
      if (mode === 'manual-download') {
        return {
          text: `Version ${state.version} is available. Download it from the releases page.`,
          action: { kind: 'open-download-page', label: 'Open download page' },
        };
      }
      return {
        text: `Version ${state.version} is available.`,
        action: state.canDownload
          ? { kind: 'download', label: 'Download update' }
          : { kind: 'open-download-page', label: 'Open download page' },
      };
    case 'downloading':
      return {
        text: `Downloading version ${state.version}… ${Math.round(state.progress || 0)}%`,
        action: null,
      };
    case 'downloaded':
      return {
        text: `Version ${state.version} is ready. Restart to install it.`,
        action: { kind: 'install', label: 'Restart to update' },
      };
    case 'error':
      return {
        text: friendlyUpdateError(state.error),
        action: { kind: 'check', label: 'Try again' },
      };
    case 'idle':
    default:
      return { text: null, action: null };
  }
}

const KNOWN_ERRORS = [
  [/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i,
    'Could not reach the update server. Check your internet connection and try again.'],
  [/404|ENOENT.*latest/i,
    'No update feed was found for this channel yet. Try again later.'],
  [/ERR_UPDATER_INVALID_SIGNATURE|signature/i,
    'The downloaded update failed its signature check and was thrown away. Nothing was installed.'],
  [/sha512|checksum/i,
    'The downloaded update did not match its checksum and was thrown away. Nothing was installed.'],
];

function friendlyUpdateError(err) {
  const raw = typeof err === 'string' ? err : err && (err.message || err.code || '');
  for (const [pattern, text] of KNOWN_ERRORS) {
    if (pattern.test(raw || '')) return text;
  }
  return raw
    ? `Update check failed: ${raw}`
    : 'Update check failed. Try again.';
}

module.exports = {
  UPDATE_MODES,
  MAC_SIGNING_VALUES,
  macSigningFromBuildConfig,
  modeFor,
  resolveChannel,
  allowPrereleaseFor,
  hasPrerelease,
  parseVersion,
  compareVersions,
  isNewerVersion,
  describeState,
  friendlyUpdateError,
};
