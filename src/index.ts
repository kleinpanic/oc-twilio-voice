import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { handleWebhook } from './webhook.js';
import { handleStream } from './stream.js';
import { initiateOutboundCall } from './outbound.js';
import { createCallHandler } from './call-api.js';

const PORT            = process.env.PORT            || 3334;
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST || 'localhost';

// Bearer token required by POST /call; the endpoint is disabled when unset
const CALL_API_TOKEN  = process.env.CALL_API_TOKEN  || process.env.OPENCLAW_HOOKS_TOKEN || '';

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/voice/stream' });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Twilio webhook (inbound + outbound answer) ───────────────────────────────
app.post('/voice/webhook', handleWebhook);

// ── Initiate outbound call ───────────────────────────────────────────────────
app.post('/call', createCallHandler(CALL_API_TOKEN, initiateOutboundCall));

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
