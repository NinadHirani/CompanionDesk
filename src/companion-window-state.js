'use strict';

// Where the companion window comes back after a move or resize. The overlay
// is movable and resizable; this module turns a saved bounds blob into a
// safe restore decision and a live getBounds() result into a saveable one.
// Pure maths and validation only: no Electron, no database, no settings.

// Same floors overlay-layout uses when it shrinks the window to a small
// display, so a restored window can never be smaller than a default one.
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;
const MAX_DIMENSION = 8192;
const COORD_LIMIT = 100000;

function isFiniteInt(v, min, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

// Strict shape: exactly the four numeric fields, integers in range, size at
// or above the minimum. Anything else (missing field, float, string, array,
// extra field) is refused: a corrupted blob can never place the window.
function parseSavedBounds(raw) {
  let b = raw;
  if (typeof raw === 'string') {
    if (raw.length > 200) return null;
    try { b = JSON.parse(raw); } catch { return null; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const keys = Object.keys(b).sort();
  if (keys.length !== 4 || keys.join(',') !== 'height,width,x,y') return null;
  const { x, y, width, height } = b;
  if (!isFiniteInt(x, -COORD_LIMIT, COORD_LIMIT)) return null;
  if (!isFiniteInt(y, -COORD_LIMIT, COORD_LIMIT)) return null;
  if (!isFiniteInt(width, MIN_WIDTH, MAX_DIMENSION)) return null;
  if (!isFiniteInt(height, MIN_HEIGHT, MAX_DIMENSION)) return null;
  return { x, y, width, height };
}

function intersectionArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return (w > 0 && h > 0) ? w * h : 0;
}

function centerDistance(a, b) {
  const acx = a.x + a.width / 2, acy = a.y + a.height / 2;
  const bcx = b.x + b.width / 2, bcy = b.y + b.height / 2;
  return Math.hypot(acx - bcx, acy - bcy);
}

// Fit the saved rect inside one work area: shrink to the area (never below
// the minimum, never above the area itself), then pin fully inside. Returns
// null when the work area itself is unusable.
function fitInto(rect, workArea) {
  if (!workArea || typeof workArea !== 'object' || !(workArea.width > 0) || !(workArea.height > 0)) return null;
  const width = Math.max(Math.min(rect.width, workArea.width), Math.min(MIN_WIDTH, workArea.width));
  const height = Math.max(Math.min(rect.height, workArea.height), Math.min(MIN_HEIGHT, workArea.height));
  const x = Math.max(workArea.x, Math.min(rect.x, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(rect.y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

// The restore decision: the saved rect comes back on the display whose work
// area it overlaps most (the monitor it was left on); when a monitor was
// unplugged and the rect now sits on no display, the nearest display takes
// it, so the window can never be lost. Any malformed input returns null and
// the caller keeps the default placement.
function restoreBounds(saved, workAreas) {
  const rect = parseSavedBounds(saved);
  if (!rect || !Array.isArray(workAreas) || workAreas.length === 0) return null;
  let bestIndex = -1, bestArea = -1, bestDist = Infinity;
  for (let i = 0; i < workAreas.length; i++) {
    const wa = workAreas[i];
    if (!wa || typeof wa !== 'object' || !(wa.width > 0) || !(wa.height > 0)) continue;
    const area = intersectionArea(rect, wa);
    const dist = centerDistance(rect, wa);
    if (area > bestArea || (area === bestArea && dist < bestDist)) {
      bestArea = area; bestDist = dist; bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;
  return fitInto(rect, workAreas[bestIndex]);
}

// A live getBounds() result becomes the saved blob. Same strictness as
// parsing: the app must never write a bounds value it could not restore.
function captureBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const shape = {};
  for (const k of ['x', 'y', 'width', 'height']) {
    const v = bounds[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    shape[k] = Math.round(v);
  }
  return parseSavedBounds(shape);
}

module.exports = { MIN_WIDTH, MIN_HEIGHT, MAX_DIMENSION, parseSavedBounds, restoreBounds, captureBounds };
