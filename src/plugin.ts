import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';

const ConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ default: true })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, default: 3334 })),
    baseUrl: Type.Optional(
      Type.String({
        description: 'Local oc-twilio-voice service base URL. Defaults to http://127.0.0.1:<port>.',
      }),
    ),
    publicUrlHost: Type.Optional(
      Type.String({
        description: 'Public hostname used by Twilio webhooks, for status reporting.',
      }),
    ),
    callApiToken: Type.Optional(
      Type.String({
        description: 'Bearer token for POST /call. Falls back to CALL_API_TOKEN or OPENCLAW_HOOKS_TOKEN.',
      }),
    ),
    defaultAgentId: Type.Optional(
      Type.String({
        default: 'main',
        description: 'Agent id used for outbound calls when no agentId is supplied.',
      }),
    ),
  },
  { additionalProperties: false },
);

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveServiceBaseUrl(config: {
  baseUrl?: string;
  port?: number;
}): string {
  const configured = nonEmptyString(config.baseUrl);
  if (configured) return trimTrailingSlash(configured);
  const port = Number.isInteger(config.port) ? config.port : 3334;
  return `http://127.0.0.1:${port}`;
}

async function parseServiceResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export default defineToolPlugin({
  id: 'oc-twilio-voice',
  name: 'OC Twilio Voice',
  description: 'Companion tools for the standalone oc-twilio-voice service.',
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: 'oc_twilio_voice_status',
      label: 'OC Twilio Voice Status',
      description: 'Check whether the local oc-twilio-voice HTTP service is reachable.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_params, config) {
        const baseUrl = resolveServiceBaseUrl(config);
        try {
          const response = await fetch(`${baseUrl}/status`);
          const service = await parseServiceResponse(response);
          return {
            ok: response.ok,
            status: response.status,
            baseUrl,
            publicUrlHost: config.publicUrlHost ?? null,
            service,
          };
        } catch (err) {
          return {
            ok: false,
            baseUrl,
            publicUrlHost: config.publicUrlHost ?? null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
    tool({
      name: 'oc_twilio_voice_call',
      label: 'OC Twilio Voice Call',
      description: 'Initiate an allowlisted outbound phone call through oc-twilio-voice.',
      optional: true,
      parameters: Type.Object(
        {
          to: Type.String({ description: 'Allowlisted E.164 phone number to call.' }),
          agentId: Type.Optional(Type.String({ description: 'OpenClaw agent id backing the call.' })),
          model: Type.Optional(Type.String({ description: 'Optional voice fallback model override.' })),
          openingMessage: Type.Optional(Type.String({ description: 'First message spoken when the call answers.' })),
        },
        { additionalProperties: false },
      ),
      async execute(params, config) {
        if (config.enabled === false) {
          return { ok: false, error: 'oc-twilio-voice is disabled in plugin config' };
        }

        const baseUrl = resolveServiceBaseUrl(config);
        const token =
          nonEmptyString(config.callApiToken) ??
          nonEmptyString(process.env.CALL_API_TOKEN) ??
          nonEmptyString(process.env.OPENCLAW_HOOKS_TOKEN);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(`${baseUrl}/call`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            to: params.to,
            agentId: params.agentId ?? config.defaultAgentId ?? 'main',
            ...(params.model ? { model: params.model } : {}),
            ...(params.openingMessage ? { openingMessage: params.openingMessage } : {}),
          }),
        });
        const service = await parseServiceResponse(response);
        return {
          ok: response.ok,
          status: response.status,
          baseUrl,
          service,
        };
      },
    }),
  ],
});
