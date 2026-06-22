# oc-twilio-voice

Custom Twilio voice server for OpenClaw.

## Architecture

Failover chain for incoming and outgoing calls:
1. **OpenAI Realtime API (GPT-4o)**: Primary path for low-latency, conversational voice bridge.
2. **STT → OpenClaw → TTS**: Fallback path if OpenAI Realtime is unavailable or fails.
   - **STT**: Local Spark (Whisper) with OpenAI Whisper API failover.
   - **LLM**: Local Spark OpenAI-compatible chat-completions (`SPARK_LLM_URL`, default `http://dgx-spark.local:18091/v1/chat/completions`; model via `VOICE_FALLBACK_MODEL`). Authed with `SPARK_API_KEY`. OpenRouter is intentionally not used.
   - **TTS**: Local Spark (Kokoro) with ElevenLabs TTS failover.

## Installation

```bash
npm install
npm run build
npm run plugin:build
npm run plugin:validate
```

## How to cut over from the old plugin

1. Stop the existing OpenClaw voice-call plugin if it's running on the same port (3334).
2. Start this service (either manually or via systemd).
3. Update your Twilio Webhook URL to: `https://{PUBLIC_URL_HOST}/voice/webhook`.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

- `OPENAI_API_KEY`: Required for OpenAI Realtime API.
- `OPENCLAW_HOOKS_TOKEN`: Required for OpenClaw gateway access.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: Required for outbound calls.
- `ALLOWED_CALLERS`: Comma-separated list of authorized phone numbers.
- `PUBLIC_URL_HOST`: The public hostname of your server (e.g., `yourserver.com`).
- `PORT`: Default 3334.

## Systemd Service Setup

Create `~/.config/systemd/user/oc-twilio-voice.service`:

```ini
[Unit]
Description=oc-twilio-voice — custom Twilio voice server
After=network-online.target openclaw-gateway.service

[Service]
WorkingDirectory=/home/broklein/codeWS/TypeScript/oc-twilio-voice
ExecStart=/home/broklein/.nvm/current/bin/node dist/index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/broklein/codeWS/TypeScript/oc-twilio-voice/.env

[Install]
WantedBy=default.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable oc-twilio-voice.service
```

## Outbound Calls

To initiate an outbound call:

```bash
curl -X POST http://localhost:3334/call \
  -H "Content-Type: application/json" \
  -d '{"to": "+1234567890"}'
```

## OpenClaw Companion Plugin

This package also exposes a native OpenClaw tool entrypoint at `./dist/plugin.js`.
The service still runs through systemd; the plugin only gives agents controlled
tools for service status and allowlisted outbound calls.

```bash
openclaw plugins install --link /home/broklein/codeWS/TypeScript/oc-twilio-voice
openclaw plugins inspect oc-twilio-voice --json
```

Tools:

- `oc_twilio_voice_status`: checks the local service `/status` endpoint.
- `oc_twilio_voice_call`: optional side-effect tool for POST `/call`.
