// Map custom-adapter errors onto the Anthropic envelopes Claude Code 2.1.310
// actually recovers from. REA + bun carve of P_r / kg:
//   400  invalid_request_error  "prompt is too long: N tokens > M maximum"
//        → compact, stay on model
//   529  overloaded_error       "Overloaded"
//        → Jet() retry, stay on model
//   other 5xx + fallbackModelCouldHelp
//        → useFallbackModel ("due to high demand")
// Relaying a Codex JSON 500 as 500 therefore hops off Astra. Empty / connect
// 5xx stay adapter-down (circuit + hop).

import {
  isContextOverflowError,
  isCustomAdapterDown,
  anthropicPromptTooLongBody,
} from './context-overflow.js';

/** Live TeamClaude contextWindows for Codex ids (not the 1.05M native window). */
export const CODEX_CONTEXT_WINDOWS = Object.freeze({
  'gpt-6-astra': 258400,
  'claude-gpt-6-astra': 258400,
  'gpt-6.1-sol': 500000,
  'gpt-6-sol': 272000,
  'gpt-6-luna': 272000,
  'gpt-5.6-terra': 272000,
  'claude-gpt-5.6-sol': 272000,
  'claude-gpt-5.6-terra': 272000,
});

export function contextWindowFor(model) {
  const id = String(model || '').replace(/\[\d+m\]$/, '');
  if (Object.prototype.hasOwnProperty.call(CODEX_CONTEXT_WINDOWS, id)) {
    return CODEX_CONTEXT_WINDOWS[id];
  }
  return 258400;
}

/** Native Anthropic 529 body. CC P_r: status === 529 → Jet (retry same model). */
export function anthropicOverloadedBody() {
  return {
    type: 'error',
    error: {
      type: 'overloaded_error',
      message: 'Overloaded',
    },
  };
}

/**
 * Shape a custom-adapter error the way api.anthropic.com would.
 * Returns null when the gateway should keep circuit/failover behavior.
 */
export function toNativeAnthropicClientError(status, bodyText, model) {
  if (isContextOverflowError(status, bodyText)) {
    return {
      status: 400,
      body: anthropicPromptTooLongBody(bodyText, contextWindowFor(model)),
      outcome: 'context-overflow-relay',
    };
  }
  if (Number(status) >= 500 && !isCustomAdapterDown(status, bodyText)) {
    return {
      status: 529,
      body: anthropicOverloadedBody(),
      outcome: 'native-overload-scaffold',
    };
  }
  return null;
}

/** Picker ids that must not inherit Opus/Sonnet catalog windows via behavesAs. */
export const CODEX_PICKER_IDS = Object.freeze(Object.keys(CODEX_CONTEXT_WINDOWS));
