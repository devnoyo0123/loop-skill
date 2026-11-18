#!/usr/bin/env node
// Loop bridge daemon — one per Mac user, owned by no Claude session.
//
//   Claude session A ─ shim (server.mjs) ─┐
//   Claude session B ─ shim (server.mjs) ─┼─ control socket ─ daemon ─ TCP 8766 ─ phone
//   Claude session C ─ shim (server.mjs) ─┘
//
// The daemon holds the phone link, the pairing code and the paired-device
// state, so every session sees the same phone and the same code. Shims start
// it on demand (detached); it exits after IDLE_MS with no shim attached.
// Phone protocol (TCP JSON lines) is unchanged — design: docs/mcp-bridge-design.md
// (loop repo, ADR-002). Zero dependencies, node >= 18.

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  VERSION as BUILD_VERSION,
  TCP_PORT,
  STATE_FILE,
  CONTROL_SOCK,
  IDLE_MS,
  LEGACY_PHONE_TOOLS,
  BRIDGE_TOOL_NAMES,
  sanitizePhoneTools,
} from './common.mjs';

// Test hook: pretend to be another version (exercises the upgrade path).
const VERSION = process.env.LOOP_BRIDGE_DAEMON_VERSION || BUILD_VERSION;
const TOOL_TIMEOUT_MS = 30_000;
const CODE_TTL_MS = 5 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const TCP_RETRY_MS = 5_000;

const log = (...a) =>
  process.stderr.write(`${new Date().toISOString()} ${a.join(' ')}\n`);

/** First LAN IPv4 of this Mac — shown in bridge_status for manual phone entry. */
function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

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
    log('state write failed:', e.message);
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
  if (!socket.destroyed) socket.write(JSON.stringify(obj) + '\n');
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

/** Tools Claude can call on the phone: the last list it advertised, else legacy. */
function currentPhoneTools() {
  return Array.isArray(state.phoneTools) && state.phoneTools.length
    ? state.phoneTools
    : LEGACY_PHONE_TOOLS;
}

/** Remember the tool list an authenticated phone advertised; notify sessions on change. */
function adoptPhoneTools(list) {
  const tools = sanitizePhoneTools(list);
  if (!tools) return; // older app (no list) or unusable list — keep what we have
  if (JSON.stringify(tools) === JSON.stringify(state.phoneTools ?? null)) return;
  state.phoneTools = tools;
  saveState();
  log(`phone tools: ${tools.map((t) => t.name).join(', ')}`);
  for (const s of shims) send(s, { event: 'tools_changed' });
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
        candidates.set(socket, { deviceId: obj.id, attempts: 0, tools: obj.tools });
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
      adoptPhoneTools(obj.tools);
      send(socket, { t: 'paired' });
      log(`phone ${dev.id} reconnected`);
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
      state.devices = state.devices.filter((d) => d.id !== cand.deviceId);
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
      adoptPhoneTools(cand.tools);
      send(socket, { t: 'paired', secret });
      log(`phone ${cand.deviceId} paired`);
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

let tcpListening = false;

const tcpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  if (phone) {
    // One phone per bridge (design §1.1).
    send(socket, { t: 'busy' });
    socket.end();
    return;
  }
  const rl = readline.createInterface({ input: socket });
  // readline re-emits socket errors (e.g. ECONNRESET when the phone drops off
  // Wi-Fi). Unhandled, that killed the whole daemon — 'close' below cleans up.
  rl.on('error', () => {});
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
      log('phone disconnected');
    }
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

tcpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Usually an older plugin (<1.2, bridge inside a session) still running.
    // Keep retrying so we take over once it exits.
    log(`port ${TCP_PORT} in use — retrying in ${TCP_RETRY_MS / 1000}s`);
    setTimeout(listenTcp, TCP_RETRY_MS).unref();
  } else {
    log('tcp error:', e.message);
  }
});

function listenTcp() {
  if (shuttingDown) return;
  tcpServer.listen(TCP_PORT, () => {
    tcpListening = true;
    log(`listening on ${TCP_PORT} for the phone`);
    advertise();
  });
}

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

// ── tools (called by shims) ──────────────────────────────────────

function bridgeStatusText() {
  const lines = [];
  if (!tcpListening) {
    lines.push(
      `Port ${TCP_PORT} is held by another program — usually an older Loop plugin ` +
        'still running in another Claude Code session. Update the plugin and restart ' +
        'that session; this bridge takes the port over automatically.',
    );
  }
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
  lines.push(`Claude sessions using this bridge: ${shims.size}. Bridge ${VERSION}.`);
  return lines.join('\n');
}

async function callTool(name, args) {
  switch (name) {
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
    default: {
      if (BRIDGE_TOOL_NAMES.includes(name) || !currentPhoneTools().some((t) => t.name === name))
        return { text: `Unknown tool: ${name}`, isError: true };
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
  }
}

// ── control socket (shims, JSON lines) ───────────────────────────
//   → {id, op:'hello', version}        ← {id, ok, version, pid}
//   → {id, op:'call', name, args}      ← {id, ok, text, isError}
//   → {id, op:'tools'}                 ← {id, ok, tools}  (phone's tool list)
//   → {id, op:'shutdown'}              ← {id, ok}   (newer shim replacing us)
//   ← {event:'tools_changed'}          (pushed when the phone advertises a new list)

/** @type {Set<net.Socket>} */
const shims = new Set();
let idleTimer = null;

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (shims.size === 0) {
    idleTimer = setTimeout(() => {
      log(`no Claude session for ${IDLE_MS / 1000}s — exiting`);
      shutdown();
    }, IDLE_MS);
  }
}

const controlServer = net.createServer((sock) => {
  sock.setEncoding('utf8');
  // A connection counts as a Claude session only after 'hello' (probes don't).
  const rl = readline.createInterface({ input: sock });
  rl.on('error', () => {}); // see the phone socket above — 'close' cleans up
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (o) => send(sock, { id: msg.id, ...o });
    switch (msg.op) {
      case 'hello':
        shims.add(sock);
        armIdle();
        reply({ ok: true, version: VERSION, pid: process.pid });
        return;
      case 'tools':
        reply({ ok: true, tools: currentPhoneTools() });
        return;
      case 'whoami': // ownership probe — not a session
        reply({ ok: true, pid: process.pid });
        return;
      case 'call': {
        try {
          const r = await callTool(msg.name, msg.args ?? {});
          reply({ ok: true, text: r.text, isError: r.isError === true });
        } catch (e) {
          reply({ ok: false, text: String(e?.message ?? e), isError: true });
        }
        return;
      }
      case 'shutdown':
        log('shutdown requested by a newer shim');
        reply({ ok: true });
        setTimeout(shutdown, 50);
        return;
      default:
        reply({ ok: false, text: `Unknown op: ${msg.op}`, isError: true });
    }
  });
  const gone = () => {
    if (shims.delete(sock)) armIdle();
  };
  sock.on('close', gone);
  sock.on('error', gone);
});

/** Bind the control socket; exit quietly if a live daemon already owns it. */
function listenControl() {
  controlServer.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') {
      log('control socket error:', e.message);
      process.exit(1);
    }
    const probe = net.connect(CONTROL_SOCK);
    probe.once('connect', () => {
      probe.destroy();
      log('another daemon is already running — exiting');
      process.exit(0);
    });
    probe.once('error', () => {
      // stale socket file from a crashed daemon
      try {
        fs.unlinkSync(CONTROL_SOCK);
      } catch {
        /* raced with another daemon */
      }
      // No callback here: a listen() callback is a 'listening' listener, and
      // the first listen() already registered one — passing it again would run
      // onControlReady twice and crash on the second tcpServer.listen().
      // The first 'error' handler was `once` and is spent: if another daemon
      // re-created the socket in between, lose quietly instead of crashing.
      controlServer.once('error', () => {
        log('another daemon won the race — exiting');
        process.exit(0);
      });
      controlServer.listen(CONTROL_SOCK);
    });
  });
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(CONTROL_SOCK), { recursive: true });
  controlServer.once('listening', onControlReady);
  controlServer.listen(CONTROL_SOCK);
}

function onControlReady() {
  log(`bridge ${VERSION} (pid ${process.pid}) ready on ${CONTROL_SOCK}`);
  armIdle();
  listenTcp();
  setTimeout(verifyOwnership, 300);
}

/**
 * Two daemons racing over a stale socket can both unlink-and-listen; the loser
 * then holds a socket nobody can reach (and maybe the phone port). Ask the path
 * who answers — if it isn't us, step aside so the reachable daemon gets the port.
 */
function verifyOwnership() {
  if (shuttingDown) return;
  const c = net.connect(CONTROL_SOCK);
  let done = false;
  const lose = (why) => {
    if (done) return;
    done = true;
    c.destroy();
    log(`control socket not ours (${why}) — exiting`);
    // Don't close controlServer: closing a unix-socket server unlinks the path,
    // which is the winner's socket file now. Exiting just drops our fd.
    if (phone) send(phone.socket, { t: 'bye' });
    process.exit(0);
  };
  c.setEncoding('utf8');
  c.once('error', () => lose('unreachable'));
  c.once('connect', () => c.write(JSON.stringify({ id: 0, op: 'whoami' }) + '\n'));
  readline.createInterface({ input: c }).once('line', (l) => {
    let pid = null;
    try {
      pid = JSON.parse(l).pid;
    } catch {
      /* fallthrough */
    }
    if (pid !== process.pid) return lose(`pid ${pid}`);
    done = true;
    c.destroy();
  });
}

// ── lifecycle ────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (phone) send(phone.socket, { t: 'bye' });
  failPending('BRIDGE_SHUTDOWN');
  if (mdns) mdns.kill();
  for (const s of shims) s.destroy();
  tcpServer.close();
  controlServer.close(); // removes the unix socket file
  setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// One bad socket must not take the phone link down for every session.
process.on('uncaughtException', (e) => log('unexpected error (kept running):', e?.stack ?? e));

listenControl();
