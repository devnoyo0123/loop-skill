// Shared constants for the Loop bridge daemon (daemon.mjs) and the per-session
// MCP shim (server.mjs). Zero dependencies, node >= 18.

import os from 'node:os';
import path from 'node:path';

/** Bridge version. A shim that is newer than the running daemon replaces it. */
export const VERSION = '1.3.1';

export const TCP_PORT = Number(process.env.LOOP_BRIDGE_PORT || 8766);

export const STATE_DIR = path.join(os.homedir(), '.loop-bridge');

export const STATE_FILE = process.env.LOOP_BRIDGE_STATE || path.join(STATE_DIR, 'state.json');

/** Local control channel between shims and the daemon (never leaves this Mac). */
export const CONTROL_SOCK =
  process.env.LOOP_BRIDGE_SOCK ||
  (process.platform === 'win32'
    ? `\\\\.\\pipe\\loop-bridge-${os.userInfo().username}`
    : path.join(STATE_DIR, 'bridge.sock'));

export const DAEMON_LOG = process.env.LOOP_BRIDGE_LOG || path.join(STATE_DIR, 'daemon.log');

/** The daemon exits after this long with no shim attached. */
export const IDLE_MS = Number(process.env.LOOP_BRIDGE_IDLE_MS || 10 * 60_000);

/** Compare dotted versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── phone tools ──────────────────────────────────────────────────
// The phone advertises its MCP tools in `hello` (Loop >= 1.0.27), so new tools
// ship with an app update alone. Older apps send none: use this fixed list.

const dateSchema = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  format: 'date',
};

/** Tools of apps that don't advertise a list (Loop < 1.0.27). */
export const LEGACY_PHONE_TOOLS = [
  {
    name: 'search_logs',
    description:
      'Full-text search over the journal (content and place). Returns matching ' +
      'logs with a snippet; matches are wrapped in **. Use get_log or get_chain ' +
      'with an id for the full text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Text to find. 3+ characters use the index.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        from: { ...dateSchema, description: 'Start date YYYY-MM-DD (inclusive, local time).' },
        to: { ...dateSchema, description: 'End date YYYY-MM-DD (inclusive, local time).' },
        order: { type: 'string', enum: ['recent', 'relevance'], default: 'recent' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_log',
    description: 'One log in full, with metadata.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_chain',
    description:
      'The whole chain (original log and all follow-ups) containing the given ' +
      'log id, oldest first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, description: 'Any log id in the chain.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'logs_on_day',
    description: 'All logs written on one day (local time), oldest first, up to 50.',
    inputSchema: {
      type: 'object',
      properties: { date: { ...dateSchema, description: 'YYYY-MM-DD' } },
      required: ['date'],
      additionalProperties: false,
    },
  },
];

/** Tools served by the bridge itself — never taken from the phone. */
export const BRIDGE_TOOL_NAMES = ['bridge_status', 'pairing_code'];

const MAX_TOOLS = 32;
const MAX_TOOLS_JSON = 64 * 1024;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Validate a tool list from the phone; null if unusable. */
export function sanitizePhoneTools(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const t of list.slice(0, MAX_TOOLS)) {
    if (!t || typeof t !== 'object') continue;
    const { name, description, inputSchema } = t;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) continue;
    if (BRIDGE_TOOL_NAMES.includes(name) || seen.has(name)) continue;
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof description === 'string' ? description.slice(0, 2000) : '',
      inputSchema,
    });
  }
  if (out.length === 0) return null;
  if (JSON.stringify(out).length > MAX_TOOLS_JSON) return null;
  return out;
}
