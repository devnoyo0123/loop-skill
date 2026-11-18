#!/usr/bin/env node
// Loop MCP shim — one per Claude Code session (stdio). It owns nothing: tool
// calls are forwarded to the shared bridge daemon (daemon.mjs) over a local
// socket, so every session sees the same phone link and pairing code. Starts
// the daemon on demand and replaces it when this plugin is newer.
// Zero dependencies, node >= 18.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, CONTROL_SOCK, DAEMON_LOG, compareVersions } from './common.mjs';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.mjs');
const CALL_TIMEOUT_MS = 40_000; // daemon's phone timeout is 30s
const log = (...a) => process.stderr.write('loop-shim: ' + a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── daemon link ──────────────────────────────────────────────────

/** @type {net.Socket | null} */
let link = null;
let nextId = 1;
/** id -> {resolve, timer} */
const waiting = new Map();
let connecting = null;
let closed = false;

function tryConnect() {
  return new Promise((resolve) => {
    const s = net.connect(CONTROL_SOCK);
    s.once('connect', () => resolve(s));
    s.once('error', () => {
      s.destroy();
      resolve(null);
    });
  });
}

function request(sock, msg, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, text: 'The Loop bridge did not answer in time.', isError: true });
    }, timeoutMs);
    waiting.set(id, { resolve, timer });
    sock.write(JSON.stringify({ id, ...msg }) + '\n');
  });
}

function attach(sock) {
  sock.setEncoding('utf8');
  const rl = readline.createInterface({ input: sock });
  rl.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  const lost = () => {
    if (link !== sock) return;
    link = null;
    for (const [, w] of waiting) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, text: 'The Loop bridge restarted — please try again.', isError: true });
    }
    waiting.clear();
    // Keep a daemon alive for this session (also keeps the phone port open).
    if (!closed) setTimeout(() => ensureDaemon().catch(() => {}), 500);
  };
  sock.on('close', lost);
  sock.on('error', lost);
}

function startDaemon() {
  let out = 'ignore';
  try {
    fs.mkdirSync(path.dirname(DAEMON_LOG), { recursive: true });
    try {
      if (fs.statSync(DAEMON_LOG).size > 1_000_000) fs.truncateSync(DAEMON_LOG, 0);
    } catch {
      /* no log yet */
    }
    out = fs.openSync(DAEMON_LOG, 'a');
  } catch {
    /* log is best-effort */
  }
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  if (typeof out === 'number') fs.closeSync(out);
}

async function connectOrStart() {
  let sock = await tryConnect();
  if (sock) return sock;
  startDaemon();
  for (let i = 0; i < 40 && !sock; i++) {
    await sleep(100);
    sock = await tryConnect();
  }
  return sock;
}

/** Connect to the daemon, starting or upgrading it as needed. */
function ensureDaemon() {
  if (link) return Promise.resolve(link);
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      for (let round = 0; round < 3; round++) {
        const sock = await connectOrStart();
        if (!sock) return null;
        attach(sock);
        const hi = await request(sock, { op: 'hello', version: VERSION }, 3_000);
        if (hi.ok && compareVersions(VERSION, hi.version) > 0) {
          // Older daemon (plugin was updated): replace it with ours.
          log(`replacing bridge ${hi.version} with ${VERSION}`);
          await request(sock, { op: 'shutdown' }, 3_000);
          sock.destroy();
          for (let i = 0; i < 30 && (await tryConnect().then((s) => (s?.destroy(), !!s))); i++) {
            await sleep(100);
          }
          continue;
        }
        if (!hi.ok) {
          sock.destroy();
          continue;
        }
        link = sock;
        return sock;
      }
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

async function callTool(name, args) {
  const sock = await ensureDaemon();
  if (!sock) {
    return {
      text:
        `Could not start the Loop bridge. Check ${DAEMON_LOG} and that node can ` +
        `create ${CONTROL_SOCK}.`,
      isError: true,
    };
  }
  const r = await request(sock, { op: 'call', name, args });
  return { text: r.text ?? '', isError: r.isError === true || r.ok === false };
}

// ── MCP over stdio ───────────────────────────────────────────────

const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const instructions =
  "Loop is the user's personal journal on their phone. Each log has an id, " +
  'timestamp, content, optional place/weather, and may belong to a chain. ' +
  'This bridge relays tool calls to the phone over the local network. Use ' +
  '`search_logs` first, then `get_log` or `get_chain` for detail. If the ' +
  'phone is not connected, ask the user to open Loop → Settings → PC 연결.';

const dateSchema = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  format: 'date',
};

const relayTools = [
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

const bridgeTools = [
  {
    name: 'bridge_status',
    description:
      'Phone link status: connected or not, paired devices, and how to connect. ' +
      'Call this first when a search tool reports the phone is not connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pairing_code',
    description:
      'Show the 8-digit pairing code for a phone waiting to pair (Loop → ' +
      'Settings → PC 연결). Present the code to the user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function textResult(id, text, isError = false) {
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return { jsonrpc: '2.0', id, result: r };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMcp(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: supportedVersions.includes(params?.protocolVersion)
            ? params.protocolVersion
            : supportedVersions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'loop', version: VERSION },
          instructions,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: [...relayTools, ...bridgeTools] },
      };
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: name');
      const r = await callTool(name, params?.arguments ?? {});
      return textResult(id, r.text, r.isError === true);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const stdinRl = readline.createInterface({ input: process.stdin });
stdinRl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n');
    return;
  }
  try {
    const res = await handleMcp(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } catch {
    process.stdout.write(
      JSON.stringify(rpcError(msg?.id ?? null, -32603, 'Internal error')) + '\n',
    );
  }
});

// ── lifecycle ────────────────────────────────────────────────────
// The daemon outlives this session; closing our link just lets it count down
// to its idle exit once every session is gone.

function shutdown() {
  closed = true;
  if (link) link.destroy();
  process.exit(0);
}
stdinRl.on('close', shutdown); // Claude Code closed the session
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Bring the daemon up right away so the phone can reconnect before any tool call.
ensureDaemon().catch((e) => log('daemon start failed:', e?.message ?? e));
