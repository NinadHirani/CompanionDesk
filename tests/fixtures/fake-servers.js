'use strict';

// Deterministic fake provider servers for contract tests. No sockets, no
// real Ollama or Gemini, no network: this fixture IS the server side of the
// HTTP contract, replayed through createAi's injectable fetchImpl. It
// records every request (method, URL, headers, body, signal) so tests can
// assert exactly what the provider layer sends, and it honors abort
// signals the way real fetch does: an aborted or timed-out call rejects
// with the matching error name and kills an in-flight stream.

const enc = new TextEncoder();

// Records every call and hands it to the test's handler, which plays the
// server. handler(call) -> Response | Promise<Response> | (throws).
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: (init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      body: typeof init.body === 'string' ? init.body : null,
      signal: init.signal || null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function jsonOk(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function jsonErr(status) {
  return new Response('{"error":"upstream"}', { status, headers: { 'content-type': 'application/json' } });
}

// Ollama's streaming chat reply: one JSON object per line, optionally with
// garbage lines mixed in after a piece (malformed-payload tests).
function ndjson(pieces, { garbageAfter = [] } = {}) {
  const lines = [];
  pieces.forEach((p, i) => {
    lines.push(JSON.stringify({ message: { content: p } }));
    if (garbageAfter.includes(i)) lines.push('<<not json>>');
  });
  return rawNdjson(lines.map((l) => l + '\n'));
}

// Raw chunked NDJSON, for tests that need lines split mid-way across
// chunks exactly as a real socket would deliver them.
function rawNdjson(chunks) {
  return new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

// A stream that emits one piece, then hangs until the caller's signal
// aborts, exactly like a real body read does when fetch is aborted.
function ndjsonHang(signal, firstPiece) {
  const keepAlive = setInterval(() => {}, 1000); // hold the loop while hanging
  const body = new ReadableStream({
    start(c) { c.enqueue(enc.encode(JSON.stringify({ message: { content: firstPiece } }) + '\n')); },
    pull() {
      return new Promise((_res, rej) => {
        const fire = () => {
          const e = new Error('The operation was aborted');
          e.name = (signal && signal.reason && signal.reason.name) || 'AbortError';
          rej(e);
        };
        if (signal && signal.aborted) fire();
        else if (signal) signal.addEventListener('abort', fire, { once: true });
      });
    },
  });
  if (signal) signal.addEventListener('abort', () => clearInterval(keepAlive), { once: true });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

// A call that never answers on its own; it rejects only when the signal
// that would abort it fires (real fetch semantics for timeouts/cancels).
function hangOnSignal(call) {
  const keepAlive = setInterval(() => {}, 1000); // hold the loop while hanging
  return new Promise((_res, rej) => {
    const fire = () => {
      clearInterval(keepAlive);
      const e = new Error('The operation was aborted');
      e.name = (call.signal && call.signal.reason && call.signal.reason.name) || 'AbortError';
      rej(e);
    };
    if (call.signal) {
      if (call.signal.aborted) fire();
      else call.signal.addEventListener('abort', fire, { once: true });
    }
  });
}

module.exports = { makeFetch, jsonOk, jsonErr, ndjson, rawNdjson, ndjsonHang, hangOnSignal };
