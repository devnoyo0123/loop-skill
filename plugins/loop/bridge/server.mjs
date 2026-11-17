#!/usr/bin/env node
// Loop bridge — stdio MCP server for Claude Code + TCP JSON-lines link for the
// Loop phone app. Design: docs/mcp-bridge-design.md (loop repo, ADR-002).
// Zero dependencies, node >= 18.

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

/** First LAN IPv4 of this Mac — shown in bridge_status for manual phone entry. */
function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

const TCP_PORT = Number(process.env.LOOP_BRIDGE_PORT || 8766);
const STATE_FILE =
  process.env.LOOP_BRIDGE_STATE ||
  path.join(os.homedir(), '.loop-bridge', 'state.json');
const TOOL_TIMEOUT_MS = 30_000;
const CODE_TTL_MS = 5 * 60_000;
const CODE_MAX_ATTEMPTS = 5;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ── pairing state ────────────────────────────────────────────────

let state = { devices: [] };

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  if (!Array.isArray(state.devices)) state = { devices: [] };
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    log('loop-bridge: state write failed:', e.message);
  }
}

loadState();

// ── phone link (TCP JSON lines) ──────────────────────────────────

/** @type {{socket: net.Socket, deviceId: string} | null} */
let phone = null;
/** Candidates that said hello but are not paired yet. socket -> {deviceId, attempts} */
const candidates = new Map();
/** @type {{code: string, expiresAt: number} | null} */
let pairingCode = null;
let nextRid = 1;
/** rid -> {resolve, reject, timer} */
const pendingCalls = new Map();

function send(socket, obj) {
  socket.write(JSON.stringify(obj) + '\n');
}

function makeCode() {
  const n = crypto.randomInt(0, 100_000_000);
  pairingCode = {
    code: String(n).padStart(8, '0'),
    expiresAt: Date.now() + CODE_TTL_MS,
  };
  return pairingCode.code;
}

function codeValid() {
  return pairingCode && Date.now() < pairingCode.expiresAt;
}

function failPending(msg) {
  for (const [, p] of pendingCalls) {
    clearTimeout(p.timer);
    p.reject(new Error(msg));
  }
  pendingCalls.clear();
}

/** Relay a tool call to the phone. Rejects if no phone is connected. */
function invokeOnPhone(tool, args) {
  return new Promise((resolve, reject) => {
    if (!phone) {
      reject(new Error('PHONE_NOT_CONNECTED'));
      return;
    }
    const rid = nextRid++;
    const timer = setTimeout(() => {
      pendingCalls.delete(rid);
      reject(new Error('PHONE_TIMEOUT'));
    }, TOOL_TIMEOUT_MS);
    pendingCalls.set(rid, { resolve, reject, timer });
    send(phone.socket, { t: 'invoke', rid, tool, args: args ?? {} });
  });
}

function onPhoneLine(obj, socket) {
  switch (obj?.t) {
    case 'hello': {
      if (obj.proto !== 1) {
        send(socket, { t: 'bye', reason: 'proto' });
        socket.end();
        return;
      }
      const dev = state.devices.find((d) => d.id === obj.id);
      if (!dev) {
        candidates.set(socket, { deviceId: obj.id, attempts: 0 });
        send(socket, { t: 'need_code' });
        return;
      }
      if (dev.secret !== obj.secret) {
        send(socket, { t: 'bye', reason: 'secret' });
        socket.end();
        return;
      }
      phone = { socket, deviceId: dev.id };
      dev.lastSeen = new Date().toISOString();
      saveState();
      send(socket, { t: 'paired' });
      log(`loop-bridge: phone ${dev.id} reconnected`);
      return;
    }
    case 'pair': {
      const cand = candidates.get(socket);
      if (!cand) {
        send(socket, { t: 'bye', reason: 'hello_first' });
        socket.end();
        return;
      }
      if (!codeValid()) {
        send(socket, { t: 'bye', reason: 'code_expired' });
        socket.end();
        return;
      }
      if (obj.code !== pairingCode.code) {
        cand.attempts++;
        const left = CODE_MAX_ATTEMPTS - cand.attempts;
        if (left <= 0) {
          candidates.delete(socket);
          send(socket, { t: 'bye', reason: 'too_many' });
          socket.end();
        } else {
          send(socket, { t: 'need_code', attemptsLeft: left });
        }
        return;
      }
      // paired — issue secret, remember device, promote socket to phone
      const secret = crypto.randomBytes(32).toString('base64url');
      state.devices.push({
        id: cand.deviceId,
        secret,
        name: obj.name ?? null,
        lastSeen: new Date().toISOString(),
      });
      saveState();
      candidates.delete(socket);
      phone = { socket, deviceId: cand.deviceId };
      pairingCode = null;
      send(socket, { t: 'paired', secret });
      log(`loop-bridge: phone ${cand.deviceId} paired`);
      return;
    }
    case 'ping':
      send(socket, { t: 'pong' });
      return;
    case 'result': {
      const p = pendingCalls.get(obj.rid);
      if (!p) return;
      pendingCalls.delete(obj.rid);
      clearTimeout(p.timer);
      if (obj.ok) p.resolve(obj.text ?? '');
      else p.reject(Object.assign(new Error(obj.error ?? 'phone error'), { phoneError: true }));
      return;
    }
    case 'bye':
      socket.end();
      return;
    default:
      send(socket, { t: 'bye', reason: 'unknown' });
  }
}

let tcpBusy = false;

const tcpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  if (phone) {
    // One phone per bridge (design §1.1) — later sessions share the owner.
    send(socket, { t: 'busy' });
    socket.end();
    return;
  }
  const rl = readline.createInterface({ input: socket });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      send(socket, { t: 'bye', reason: 'bad_json' });
      socket.end();
      return;
    }
    onPhoneLine(obj, socket);
  });
  const drop = () => {
    candidates.delete(socket);
    if (phone && phone.socket === socket) {
      phone = null;
      failPending('PHONE_DISCONNECTED');
      log('loop-bridge: phone disconnected');
    }
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

tcpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    tcpBusy = true;
    log(`loop-bridge: port ${TCP_PORT} in use — another session owns the phone link`);
  } else {
    log('loop-bridge: tcp error:', e.message);
  }
});

tcpServer.listen(TCP_PORT, () => {
  log(`loop-bridge: listening on ${TCP_PORT} for the phone`);
  advertise();
});

// ── mDNS advertisement (system binary, best-effort) ──────────────

let mdns = null;

function advertise() {
  try {
    const cmd =
      process.platform === 'darwin'
        ? ['dns-sd', ['-R', 'Loop Bridge', '_loop-bridge._tcp', '.', String(TCP_PORT)]]
        : process.platform === 'linux'
          ? ['avahi-publish-service', ['Loop Bridge', '_loop-bridge._tcp', String(TCP_PORT)]]
          : null;
    if (!cmd) return;
    mdns = spawn(cmd[0], cmd[1], { stdio: 'ignore' });
    mdns.on('error', () => (mdns = null)); // not installed — manual IP entry still works
  } catch {
    mdns = null;
  }
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

function bridgeStatusText() {
  const lines = [];
  if (tcpBusy) lines.push(`Another Claude session owns the phone link (port ${TCP_PORT} in use).`);
  const ip = lanIp();
  if (ip) lines.push(`This Mac's address for the phone: ${ip} (port ${TCP_PORT}).`);
  if (phone) {
    lines.push(`Phone connected (device ${phone.deviceId}).`);
  } else {
    lines.push('Phone not connected.');
    lines.push(
      'Ask the user to open Loop → Settings → PC 연결 on the phone and connect ' +
        `to this Mac (port ${TCP_PORT}).`,
    );
  }
  lines.push(`Paired devices on this Mac: ${state.devices.length}.`);
  return lines.join('\n');
}

async function callTool(name, args) {
  switch (name) {
    case 'search_logs':
    case 'get_log':
    case 'get_chain':
    case 'logs_on_day': {
      let text;
      try {
        text = await invokeOnPhone(name, args);
      } catch (e) {
        if (e.message === 'PHONE_NOT_CONNECTED' || e.message === 'PHONE_DISCONNECTED')
          return { text: bridgeStatusText(), isError: true };
        if (e.message === 'PHONE_TIMEOUT')
          return { text: 'The phone did not answer within 30s. Is the app open in the foreground?', isError: true };
        return { text: String(e.message), isError: true };
      }
      return { text };
    }
    case 'bridge_status':
      return { text: bridgeStatusText() };
    case 'pairing_code': {
      const code = codeValid() ? pairingCode.code : makeCode();
      const mins = Math.max(1, Math.ceil((pairingCode.expiresAt - Date.now()) / 60_000));
      return {
        text:
          `Pairing code: ${code} (valid ${mins} min).\n` +
          'Tell the user to enter this code in Loop → Settings → PC 연결 on the waiting phone.',
      };
    }
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
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
          serverInfo: { name: 'loop', version: '1.0.0' },
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

function shutdown() {
  if (phone) send(phone.socket, { t: 'bye' });
  failPending('BRIDGE_SHUTDOWN');
  if (mdns) mdns.kill();
  tcpServer.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
