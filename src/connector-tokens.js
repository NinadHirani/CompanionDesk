/**
 * OAuth token lifecycle helpers for the connector adapters (27 Nov 2026,
 * Ninad's batch-2 go-ahead). Pure: no fs, no network, no side effects.
 *
 * An oauth_json credential is the JSON blob the in-app OAuth exchange
 * stores in the OS vault: { client_id, client_secret, access_token,
 * refresh_token, expires_at }. These helpers decide whether that blob
 * needs a refresh before an action runs, whether it CAN be refreshed
 * (refresh token + client credentials present), how a provider's token
 * response merges back into the blob (refresh-token rotation honoured:
 * a new refresh token replaces the old, otherwise the old is kept), and
 * how a failed refresh classifies (reauth_required vs a transient
 * refresh_failed). Nothing here ever logs or returns secret material.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionConnectorTokens = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Refresh this far before the real expiry so an in-flight action does
  // not race the token's last seconds.
  var DEFAULT_SKEW_MS = 60000;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  }

  function parseBlob(credential) {
    if (typeof credential !== 'string' || credential.length === 0) return { ok: false, reason: 'credential_missing' };
    if (credential.length > 4096) return { ok: false, reason: 'credential_invalid' };
    var blob = null;
    try { blob = JSON.parse(credential); } catch (e) { return { ok: false, reason: 'credential_invalid' }; }
    if (!isPlainObject(blob)) return { ok: false, reason: 'credential_invalid' };
    if (typeof blob.access_token !== 'string' || blob.access_token.length === 0) return { ok: false, reason: 'credential_invalid' };
    return { ok: true, blob: blob };
  }

  function hasText(v) { return typeof v === 'string' && v.length > 0; }

  // A refresh needs the refresh token AND the user's own client
  // credentials (the app never holds a shared client).
  function canRefresh(blob) {
    if (!isPlainObject(blob)) return false;
    return hasText(blob.refresh_token) && hasText(blob.client_id) && hasText(blob.client_secret);
  }

  // True when the blob carries a numeric expires_at that is inside the
  // refresh window. A blob with no known expiry (expires_at null) never
  // triggers a proactive refresh: we cannot know, so we do not guess.
  function needsRefresh(blob, nowMs, skewMs) {
    if (!isPlainObject(blob)) return false;
    if (typeof blob.expires_at !== 'number' || !isFinite(blob.expires_at)) return false;
    var skew = typeof skewMs === 'number' && isFinite(skewMs) ? skewMs : DEFAULT_SKEW_MS;
    return nowMs >= blob.expires_at - skew;
  }

  // Parse a provider token response. Requires a non-empty access_token;
  // expires_in (seconds) becomes expires_at; a non-empty refresh_token
  // means the provider rotated it and the new one must replace the old.
  function parseTokenResponse(body) {
    var tok = null;
    if (typeof body === 'string' && body.length > 0) {
      try { tok = JSON.parse(body); } catch (e) { return { ok: false, reason: 'token_response_invalid' }; }
    } else if (isPlainObject(body)) {
      tok = body;
    }
    if (!isPlainObject(tok)) return { ok: false, reason: 'token_response_invalid' };
    if (!hasText(tok.access_token)) return { ok: false, reason: 'token_response_invalid' };
    return {
      ok: true,
      token: {
        access_token: tok.access_token,
        // A lifetime must be a finite positive number. Zero or negative
        // would mint a credential that is born expired (needsRefresh fires
        // immediately, which can push a caller into a refresh loop), so a
        // non-positive or non-finite expires_in is an UNKNOWN expiry, not
        // a past one.
        expires_in: (typeof tok.expires_in === 'number' && isFinite(tok.expires_in) && tok.expires_in > 0) ? tok.expires_in : null,
        refresh_token: hasText(tok.refresh_token) ? tok.refresh_token : null,
      },
    };
  }

  // Merge a parsed token response into the stored blob. The client
  // credentials are preserved (the refresh needs them again next time);
  // access_token is replaced; expires_at is recomputed when expires_in is
  // known and null otherwise (never guessed).
  function applyRefresh(oldBlob, token, nowMs) {
    if (!isPlainObject(oldBlob) || !isPlainObject(token) || !hasText(token.access_token)) {
      return { ok: false, reason: 'token_response_invalid' };
    }
    var next = Object.assign({}, oldBlob, {
      access_token: token.access_token,
      refresh_token: hasText(token.refresh_token) ? token.refresh_token : oldBlob.refresh_token,
      expires_at: (typeof token.expires_in === 'number' && isFinite(token.expires_in) && typeof nowMs === 'number')
        ? nowMs + token.expires_in * 1000
        : (typeof oldBlob.expires_at === 'number' ? oldBlob.expires_at : null),
    });
    return { ok: true, blob: next };
  }

  // Classify a failed refresh: 400/401 from the token endpoint means the
  // grant itself is dead or the client credentials are wrong, so only a
  // fresh user sign-in can fix it (reauth_required). Anything else (429,
  // 5xx, transport trouble) is treated as transient (refresh_failed) and
  // the stored credential is kept untouched.
  function classifyRefreshFailure(status) {
    return (status === 400 || status === 401) ? 'reauth_required' : 'refresh_failed';
  }

  return {
    DEFAULT_SKEW_MS: DEFAULT_SKEW_MS,
    parseBlob: parseBlob,
    canRefresh: canRefresh,
    needsRefresh: needsRefresh,
    parseTokenResponse: parseTokenResponse,
    applyRefresh: applyRefresh,
    classifyRefreshFailure: classifyRefreshFailure,
  };
});
