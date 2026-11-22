'use strict';

// Where the overlay window goes. Pure maths on a display's work area (the
// screen minus menu bar and dock), so it is testable and never off-screen.

const DEFAULT_SIZE = Object.freeze({ width: 560, height: 420 });
const MARGIN = 16;

// Centered horizontally, a little below the top, like a launcher. If the work
// area is smaller than the window, the window shrinks to fit.
function overlayBounds(workArea, size = DEFAULT_SIZE) {
  const width = Math.max(240, Math.min(size.width, workArea.width - MARGIN * 2));
  const height = Math.max(160, Math.min(size.height, workArea.height - MARGIN * 2));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + Math.min(workArea.height * 0.14, workArea.height - height - MARGIN));
  return { x, y, width, height };
}

module.exports = { overlayBounds, DEFAULT_SIZE };
