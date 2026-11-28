'use strict';

// M8 batch 53 (28 Nov 2026, standing authorization): the model.infer scope
// both local catalog rows already declare (class read_only) gets real
// actions. Ollama generate (/api/generate) and LM Studio chat completions
// (/v1/chat/completions) are local-only, keyless POSTs: the request goes to
// the user's own machine, never to a remote host, and performs no write,
// send or external action. These tests assert request building and
// validation only; nothing here connects a service, touches a credential
// or performs an external action, and execution still sits behind the full
// gate chain (connect with model.infer granted, then the consent chain).

const test = require('node:test');
const assert = require('node:assert');
const adapters = require('../src/connector-adapters.js');

test('each local adapter now carries its declared infer action', () => {
  const o = adapters.listActions('ollama').map(a => a.id);
  assert.deepEqual(o.sort(), ['generate', 'list_models']);
  const l = adapters.listActions('lm-studio').map(a => a.id);
  assert.deepEqual(l.sort(), ['chat', 'list_models']);
  const og = adapters.listActions('ollama').find(a => a.id === 'generate');
  assert.equal(og.kind, 'read_only');
  assert.equal(og.scope, 'model.infer');
  const lc = adapters.listActions('lm-studio').find(a => a.id === 'chat');
  assert.equal(lc.kind, 'read_only');
  assert.equal(lc.scope, 'model.infer');
});

test('ollama generate builds a local POST with a JSON body and no secret', () => {
  const r = adapters.buildRequest('ollama', 'generate', { model: 'llama3', prompt: 'Summarise this note.' });
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(r.request.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(r.request.body).model, 'llama3');
  assert.equal(JSON.parse(r.request.body).prompt, 'Summarise this note.');
  assert.equal(JSON.parse(r.request.body).stream, false);
  assert.equal(r.request.urlContainsSecret, false);
});

test('lm-studio chat builds the OpenAI-compatible local POST', () => {
  const r = adapters.buildRequest('lm-studio', 'chat', { model: 'local-model', prompt: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.url, 'http://127.0.0.1:1234/v1/chat/completions');
  const body = JSON.parse(r.request.body);
  assert.equal(body.model, 'local-model');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(body.stream, false);
  assert.equal(r.request.urlContainsSecret, false);
});

test('a custom loopback instance is honoured; a remote host is refused', () => {
  const r = adapters.buildRequest('ollama', 'generate', { model: 'm', prompt: 'p', instanceUrl: 'http://localhost:9999' });
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'http://localhost:9999/api/generate');
  const bad = adapters.buildRequest('lm-studio', 'chat', { model: 'm', prompt: 'p', instanceUrl: 'http://example.com:1234' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'param_invalid');
});

test('param validation stays strict', () => {
  assert.equal(adapters.validateOnly('ollama', 'generate', {}), 'param_missing');
  assert.equal(adapters.validateOnly('ollama', 'generate', { model: 'm' }), 'param_missing');
  assert.equal(adapters.validateOnly('ollama', 'generate', { model: 'm', prompt: 'p' }), null);
  const long = adapters.buildRequest('lm-studio', 'chat', { model: 'm', prompt: 'p'.repeat(4001) });
  assert.equal(long.ok, false);
  assert.equal(long.reason, 'param_invalid');
  const control = adapters.buildRequest('ollama', 'generate', { model: 'm', prompt: 'a\u0000b' });
  assert.equal(control.ok, false);
  assert.equal(control.reason, 'param_invalid');
});
