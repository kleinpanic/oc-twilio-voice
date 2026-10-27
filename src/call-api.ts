/**
 * POST /call handler.
 * Body: { to, agentId?, model?, openingMessage? }
 * Header: Authorization: Bearer <CALL_API_TOKEN>
 */

import { Request, Response } from 'express';
import type { CallOptions, CallResult } from './outbound.js';
import { safeEqual } from './security.js';

const OPTIONAL_FIELDS = ['agentId', 'model', 'openingMessage'] as const;

export function createCallHandler(
  callApiToken: string,
  initiate: (opts: CallOptions) => Promise<CallResult>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    // Fail closed: without a configured token nobody may trigger calls.
    if (!callApiToken) {
      res.status(503).json({ error: 'CALL_API_TOKEN (or OPENCLAW_HOOKS_TOKEN) is not configured' });
      return;
    }
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(auth, callApiToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.to !== 'string' || !body.to) {
      res.status(400).json({ error: 'Missing required field: to' });
      return;
    }
    for (const field of OPTIONAL_FIELDS) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        res.status(400).json({ error: `Field ${field} must be a string` });
        return;
      }
    }
    const opts: CallOptions = {
      to:             body.to,
      agentId:        body.agentId as string | undefined,
      model:          body.model as string | undefined,
      openingMessage: body.openingMessage as string | undefined,
    };

    try {
      const result = await initiate(opts);
      console.log(`[index] Outbound call initiated: ${JSON.stringify(result)}`);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[index] Outbound call failed:', msg);
      res.status(500).json({ error: msg });
    }
  };
}
