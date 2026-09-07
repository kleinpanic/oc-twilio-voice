import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { handleWebhook } from './webhook.js';
import { handleStream } from './stream.js';
import { initiateOutboundCall, type CallOptions } from './outbound.js';

const PORT            = process.env.PORT            || 3334;
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST || 'localhost';

// Simple bearer token guard for the /call endpoint so any agent can call in
const CALL_API_TOKEN  = process.env.CALL_API_TOKEN  || process.env.OPENCLAW_HOOKS_TOKEN || '';

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/voice/stream' });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Twilio webhook (inbound + outbound answer) ───────────────────────────────
app.post('/voice/webhook', handleWebhook);

// ── Initiate outbound call ───────────────────────────────────────────────────
// POST /call
// Body: { to, agentId?, model?, openingMessage? }
// Header: Authorization: Bearer <CALL_API_TOKEN>
app.post('/call', async (req, res) => {
  // Light auth — only agents with the token can initiate calls
  if (CALL_API_TOKEN) {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (auth !== CALL_API_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const opts = req.body as CallOptions;
  if (!opts.to) {
    res.status(400).json({ error: 'Missing required field: to' });
    return;
  }

  try {
    const result = await initiateOutboundCall(opts);
    console.log(`[index] Outbound call initiated: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[index] Outbound call failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Status ───────────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({ ok: true, port: PORT, publicUrl: PUBLIC_URL_HOST });
});

// ── WebSocket stream handler ──────────────────────────────────────────────────
handleStream(wss);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[index] oc-twilio-voice listening on port ${PORT}`);
  console.log(`[index] Webhook endpoint: https://${PUBLIC_URL_HOST}/voice/webhook`);
  console.log(`[index] Stream  endpoint: wss://${PUBLIC_URL_HOST}/voice/stream`);
  console.log(`[index] Call    endpoint: http://localhost:${PORT}/call`);
});

function shutdown(signal: string): void {
  console.log(`[index] Received ${signal}, shutting down...`);
  server.close(() => { console.log('[index] Server closed'); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
