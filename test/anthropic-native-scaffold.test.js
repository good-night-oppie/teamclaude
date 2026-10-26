import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowFor,
  anthropicOverloadedBody,
  toNativeAnthropicClientError,
  CODEX_PICKER_IDS,
} from '../src/anthropic-native-scaffold.js';
import { isAnthropicPromptTooLong } from '../src/context-overflow.js';

test('Codex windows match TeamClaude contextWindows, not Opus 1M', () => {
  assert.equal(contextWindowFor('gpt-6-astra'), 258400);
  assert.equal(contextWindowFor('gpt-6.1-sol'), 500000);
  assert.equal(contextWindowFor('gpt-6-sol'), 272000);
  assert.equal(contextWindowFor('gpt-5.6-terra'), 272000);
  assert.equal(contextWindowFor('gpt-6-astra[1m]'), 258400);
  assert.ok(CODEX_PICKER_IDS.includes('gpt-6-astra'));
});

test('overflow maps to CC compact regex at the model window', () => {
  const native = toNativeAnthropicClientError(
    502, '{"error":"context_length_exceeded: 295400 tokens > 258400"}', 'gpt-6-astra',
  );
  assert.equal(native.status, 400);
  assert.equal(native.outcome, 'context-overflow-relay');
  assert.equal(native.body.error.type, 'invalid_request_error');
  assert.equal(true, isAnthropicPromptTooLong(native.body.error.message));
  assert.match(native.body.error.message, /258400 maximum/);
});

test('JSON 500 maps to native 529 overloaded so CC Jet-retries the same model', () => {
  const native = toNativeAnthropicClientError(
    500, '{"error":{"message":"Internal server error"}}', 'gpt-6-astra',
  );
  assert.equal(native.status, 529);
  assert.equal(native.outcome, 'native-overload-scaffold');
  assert.deepEqual(native.body, anthropicOverloadedBody());
  assert.equal(native.body.error.type, 'overloaded_error');
});

test('empty 5xx and connect failures stay unscaffolded (circuit)', () => {
  assert.equal(toNativeAnthropicClientError(500, '', 'gpt-6-astra'), null);
  assert.equal(toNativeAnthropicClientError(503, '{"error":"adapter unavailable"}', 'gpt-6.1-sol'), null);
  assert.equal(toNativeAnthropicClientError(502, 'econnrefused', 'gpt-5.6-terra'), null);
});
