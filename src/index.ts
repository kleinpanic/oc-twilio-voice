import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { handleWebhook } from './webhook';
import { handleStream } from './stream';
import { initiateOutboundCall } from './outbound';

const PORT = process.env.PORT || 3334;
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST || 'localhost';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/voice/stream' });

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio Webhook
app.post('/voice/webhook', handleWebhook);

// Status route
app.get('/session', (req, res) => {
  res.json({
    active: true,
    port: PORT,
    publicUrl: PUBLIC_URL_HOST,
  });
});

// Outbound call route
app.post('/call/outbound', async (req, res) => {
  const { to } = req.body;
  
  if (!to) {
    return res.status(400).json({ error: 'Missing "to" number' });
  }

  try {
    const callSid = await initiateOutboundCall(to);
    res.json({ ok: true, callSid });
  } catch (err: any) {
    console.error('[index] Outbound call failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// WebSocket Handling
handleStream(wss);

// Server start
server.listen(PORT, () => {
  console.log(`[index] oc-twilio-voice listening on port ${PORT}`);
  console.log(`[index] Webhook endpoint: http://${PUBLIC_URL_HOST}/voice/webhook`);
  console.log(`[index] Stream endpoint: wss://${PUBLIC_URL_HOST}/voice/stream`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[index] Received ${signal}, shutting down...`);
  server.close(() => {
    console.log('[index] Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
