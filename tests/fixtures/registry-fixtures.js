'use strict';

// Test fixtures for the provider registry. The REAL registry marks
// gemini-2.0-flash retired (verified June 1, 2026); the production
// gateway refuses it. These fixtures exist so transport-contract tests
// can still exercise the cloud path against an AVAILABLE cloud model,
// exactly the situation that returns when Ninad registers a verified
// replacement. They are test-only: production code passes nothing and
// cannot bypass the retirement check.

const Real = require('../../src/provider-registry');

// The real registry with the retired id flipped to available, so the
// pre-retirement transport contract stays pinned.
function makeTestRegistry() {
  return Object.assign({}, Real, {
    getModel(providerId, modelId) {
      const m = Real.getModel(providerId, modelId);
      return (m && m.status === 'retired') ? Object.assign({}, m, { status: 'available' }) : m;
    },
    isSelectable() { return true; },
  });
}

module.exports = { makeTestRegistry };
