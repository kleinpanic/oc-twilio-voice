/**
 * Shared input/auth helpers for the HTTP and WebSocket boundaries.
 */

import crypto from 'crypto';

/** Parse a comma-separated allowlist, dropping blank entries. */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(n => n.trim()).filter(Boolean);
}

/** Escape a value for use inside an XML attribute or text node. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

// ── One-time stream tokens ───────────────────────────────────────────────────
// The webhook issues a token per call and embeds it in the TwiML <Stream>.
// The WebSocket handler only accepts a stream whose token was issued for the
// same CallSid, and each token can be used once.

const STREAM_TOKEN_TTL_MS = 2 * 60 * 1000;
const streamTokens = new Map<string, { callSid: string; expiresAt: number }>();

export function issueStreamToken(callSid: string, now = Date.now()): string {
  for (const [token, entry] of streamTokens) {
    if (entry.expiresAt <= now) streamTokens.delete(token);
  }
  const token = crypto.randomUUID();
  streamTokens.set(token, { callSid, expiresAt: now + STREAM_TOKEN_TTL_MS });
  return token;
}

export function consumeStreamToken(token: unknown, callSid: unknown, now = Date.now()): boolean {
  if (typeof token !== 'string' || typeof callSid !== 'string' || !callSid) return false;
  const entry = streamTokens.get(token);
  if (!entry) return false;
  streamTokens.delete(token);
  return entry.expiresAt > now && entry.callSid === callSid;
}
