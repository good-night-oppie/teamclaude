// Ingress strip of foreign thinking / redacted_thinking blocks (D3 / B8).
//
// When a session previously served by a non-Anthropic family (sakana/codex/…)
// rotates onto a real Anthropic account, Anthropic 400s on foreign thinking
// signatures (`Invalid signature in thinking block`, x-should-retry:false).
// The client self-heals by stripping + retrying, but each retry re-uploads the
// full context. This pass moves the strip to INGRESS so the first upstream
// attempt already succeeds.
//
// Detection is LEDGER-based (T2 served-family), never signature-parsing. Empty
// ledger (restart wipe / TTL) ⇒ inert — client self-heal remains the safety net.
// Config-gated: absent/false ingressThinkingStrip ⇒ today byte-identical.

const MESSAGES_PATH = '/v1/messages';
const THINKING_MARKER = Buffer.from('"thinking"');
const REDACTED_MARKER = Buffer.from('"redacted_thinking"');

function isMessagesRequest(url, contentType) {
  if (typeof url !== 'string' || !url.includes(MESSAGES_PATH)) return false;
  if (contentType && !/json/i.test(contentType)) return false;
  return true;
}

function toBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return null;
}

function coalesceSameRole(messages) {
  const out = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && msg && prev.role && prev.role === msg.role) {
      const a = toBlocks(prev.content);
      const b = toBlocks(msg.content);
      if (a && b) {
        out[out.length - 1] = { ...prev, content: [...a, ...b] };
        continue;
      }
    }
    out.push(msg);
  }
  return out;
}

/**
 * True when the forward path should strip thinking blocks:
 * enabled + Anthropic target family + ledger shows ≥1 non-anthropic family.
 * Empty / anthropic-only ledger ⇒ false (inert / caching-safe).
 */
export function shouldStripForeignThinking({ enabled, targetFamily, servedFamilies }) {
  if (!enabled) return false;
  if (targetFamily !== 'anthropic') return false;
  const served = Array.isArray(servedFamilies) ? servedFamilies : [];
  if (!served.length) return false;
  return served.some(f => f != null && String(f) !== 'anthropic');
}

/**
 * Drop every thinking / redacted_thinking content block from messages[].
 * Emptied content arrays drop their message (API requires non-empty content);
 * adjacent same-role messages are coalesced so roles still alternate.
 *
 * @returns {{ body: Buffer, count: number }} original Buffer when count===0.
 */
export function stripThinkingBlocks(body, url, contentType) {
  if (!Buffer.isBuffer(body) || body.length === 0) return { body, count: 0 };
  if (!isMessagesRequest(url, contentType)) return { body, count: 0 };
  if (!body.includes(THINKING_MARKER) && !body.includes(REDACTED_MARKER)) {
    return { body, count: 0 };
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, count: 0 };
  }
  if (!payload || !Array.isArray(payload.messages)) return { body, count: 0 };

  let count = 0;
  let droppedMsg = false;
  const nextMessages = [];
  for (const msg of payload.messages) {
    if (!msg || !Array.isArray(msg.content)) {
      nextMessages.push(msg);
      continue;
    }
    const kept = [];
    for (const b of msg.content) {
      if (b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking')) {
        count += 1;
        continue;
      }
      kept.push(b);
    }
    if (kept.length === 0) {
      droppedMsg = true;
      continue;
    }
    if (kept.length !== msg.content.length) {
      nextMessages.push({ ...msg, content: kept });
    } else {
      nextMessages.push(msg);
    }
  }

  if (count === 0) return { body, count: 0 };

  payload.messages = droppedMsg ? coalesceSameRole(nextMessages) : nextMessages;
  return { body: Buffer.from(JSON.stringify(payload), 'utf8'), count };
}
