#!/usr/bin/env node
// E2E self-test for the shared bridge: two Claude sessions (shims over stdio),
// one daemon, one fake phone (TCP). Isolated port, state, socket and log —
// safe to run next to a real bridge.
// Usage: node test.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { VERSION } from './common.mjs';

const PORT = 18766;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
const ENV = {
  ...process.env,
  LOOP_BRIDGE_PORT: String(PORT),
  LOOP_BRIDGE_STATE: path.join(DIR, 'state.json'),
  LOOP_BRIDGE_SOCK: path.join(DIR, 'b.sock'),
  LOOP_BRIDGE_LOG: path.join(DIR, 'daemon.log'),
  LOOP_BRIDGE_IDLE_MS: '1500',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

// ── a Claude session = one shim process driven over stdio ──
const shims = [];
function session() {
  const proc = spawn(process.execPath, ['server.mjs'], { env: ENV });
  const pending = new Map();
  let next = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result?.content?.[0]?.text ?? '', isError: r.result?.isError === true };
  };
  const s = { proc, rpc, tool, kill: () => proc.kill() };
  shims.push(s);
  return s;
}

/** Talk to the daemon's control socket directly (like a shim would). */
function control(msg) {
  return new Promise((resolve) => {
    const c = net.connect(ENV.LOOP_BRIDGE_SOCK);
    c.setEncoding('utf8');
    c.once('error', () => resolve(null));
    c.once('connect', () => c.write(JSON.stringify({ id: 1, ...msg }) + '\n'));
    const rl = readline.createInterface({ input: c });
    rl.on('error', () => resolve(null));
    rl.once('line', (l) => { resolve(JSON.parse(l)); c.destroy(); });
  });
}
const socketAlive = () =>
  new Promise((r) => { const c = net.connect(ENV.LOOP_BRIDGE_SOCK); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
const portOpen = () =>
  new Promise((r) => { const c = net.connect(PORT, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
async function waitFor(cond, ms = 4000) {
  for (let t = 0; t < ms; t += 100) { if (await cond()) return true; await sleep(100); }
  return false;
}
const sessionsUsing = (text) => Number(text.match(/sessions using this bridge: (\d+)/)?.[1]);

// ── fake phone (TCP JSON lines) ──
let phoneSocket = null;
let last = null;
const invokes = [];
const invokeWaiters = [];
async function connectPhone() {
  await waitFor(portOpen);
  phoneSocket = net.connect(PORT, '127.0.0.1');
  await new Promise((r) => phoneSocket.once('connect', r));
  phoneSocket.setEncoding('utf8');
  phoneSocket.on('error', () => {});
  readline.createInterface({ input: phoneSocket }).on('line', (l) => {
    const m = JSON.parse(l);
    last = m;
    if (m.t === 'invoke') {
      if (invokeWaiters.length) invokeWaiters.shift()(m);
      else invokes.push(m);
    }
  });
}
const toPhone = (o) => phoneSocket.write(JSON.stringify(o) + '\n');
const awaitInvoke = () => invokes.length ? Promise.resolve(invokes.shift()) : new Promise((r) => invokeWaiters.push(r));
async function phoneMsg() { await sleep(300); return last; }

// ── scenario ──
const deviceId = 'test-phone-' + Date.now();
try {
  // Two sessions start at the same time — must end up on ONE daemon.
  const A = session();
  const B = session();

  const init = await A.rpc('initialize', { protocolVersion: '2025-06-18' });
  ok('initialize → serverInfo', init.result?.serverInfo?.name === 'loop' && init.result.serverInfo.version === VERSION);
  ok('initialize → echoes requested protocolVersion', init.result?.protocolVersion === '2025-06-18');
  const list = await B.rpc('tools/list', {});
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  ok('tools/list → 6 tools', names.length === 6 &&
    ['search_logs', 'get_log', 'get_chain', 'logs_on_day', 'bridge_status', 'pairing_code'].every((n) => names.includes(n)));

  ok('both sessions share one daemon', await waitFor(async () => sessionsUsing((await A.tool('bridge_status')).text) === 2));
  ok('daemon owns the phone port', await waitFor(portOpen));

  ok('search without phone → isError', (await A.tool('search_logs', { query: 'x' })).isError);

  await connectPhone();
  toPhone({ t: 'hello', id: deviceId, proto: 1 });
  ok('hello (new) → need_code', (await phoneMsg())?.t === 'need_code');

  // THE BUG: code from session B must be the one the phone's bridge expects.
  const code = (await B.tool('pairing_code')).text.match(/(\d{8})/)?.[1];
  ok('pairing_code (session B) → 8 digits', !!code);
  ok('pairing_code (session A) → same code', (await A.tool('pairing_code')).text.includes(code));

  toPhone({ t: 'pair', code: code === '00000000' ? '11111111' : '00000000' });
  ok('wrong code → need_code + attemptsLeft', (await phoneMsg())?.attemptsLeft === 4);

  toPhone({ t: 'pair', code });
  const paired = await phoneMsg();
  ok('pair with session B code → paired + secret', paired?.t === 'paired' && paired.secret?.length >= 40);

  const saved = JSON.parse(fs.readFileSync(ENV.LOOP_BRIDGE_STATE, 'utf8'));
  ok('state.json → device saved', saved.devices.some((d) => d.id === deviceId));

  for (const [label, S] of [['A', A], ['B', B]]) {
    const p = S.tool('search_logs', { query: '망원경' });
    const inv = await awaitInvoke();
    ok(`session ${label} → invoke on phone`, inv?.tool === 'search_logs' && inv.args.query === '망원경');
    toPhone({ t: 'result', rid: inv.rid, ok: true, text: `결과-${label}` });
    const r = await p;
    ok(`session ${label} search → relayed text`, r.text === `결과-${label}` && !r.isError);
  }

  const errP = A.tool('get_log', { id: 'nope' });
  const inv2 = await awaitInvoke();
  toPhone({ t: 'result', rid: inv2.rid, ok: false, error: 'No such log: nope' });
  const errRes = await errP;
  ok('phone error → isError with message', errRes.isError && errRes.text.includes('No such log'));

  ok('bridge_status → connected', (await B.tool('bridge_status')).text.includes('Phone connected'));

  // Session A ends — the phone link must survive for session B.
  A.kill();
  ok('session A gone → 1 session left', await waitFor(async () => sessionsUsing((await B.tool('bridge_status')).text) === 1));
  const pB = B.tool('search_logs', { query: '계속' });
  const inv3 = await awaitInvoke();
  toPhone({ t: 'result', rid: inv3.rid, ok: true, text: '여전히 연결됨' });
  ok('session B still searches after A quit', (await pB).text === '여전히 연결됨');

  phoneSocket.destroy();
  await sleep(300);
  ok('search after phone disconnect → isError', (await B.tool('search_logs', { query: 'x' })).isError);

  ok('unknown method → -32601', (await B.rpc('no/such', {})).error?.code === -32601);

  // Last session ends → daemon exits after IDLE_MS (1.5s in this test).
  B.kill();
  ok('no sessions → daemon exits (socket closed)', await waitFor(async () => !(await socketAlive()), 5000));
  ok('no sessions → phone port released', await waitFor(async () => !(await portOpen()), 3000));

  // Upgrade: an older daemon is running; a newer shim replaces it.
  const old = spawn(process.execPath, ['daemon.mjs'], { env: { ...ENV, LOOP_BRIDGE_DAEMON_VERSION: '1.0.0' }, stdio: 'ignore' });
  await waitFor(socketAlive);
  ok('old daemon (1.0.0) running', (await control({ op: 'hello' }))?.version === '1.0.0');
  const C = session();
  ok('newer shim replaces old daemon', await waitFor(async () => (await C.tool('bridge_status')).text.includes(`Bridge ${VERSION}`), 6000));
  ok('old daemon process exited', await waitFor(async () => old.exitCode !== null, 3000));
  C.kill();
  await waitFor(async () => !(await socketAlive()), 5000);

  // Downgrade guard: an older shim must NOT kill a newer daemon.
  const newer = spawn(process.execPath, ['daemon.mjs'], { env: { ...ENV, LOOP_BRIDGE_DAEMON_VERSION: '99.0.0' }, stdio: 'ignore' });
  await waitFor(socketAlive);
  const D = session();
  ok('shim keeps a newer daemon', (await D.tool('bridge_status')).text.includes('Bridge 99.0.0') && newer.exitCode === null);
  D.kill();
  await control({ op: 'shutdown' });
  await waitFor(async () => !(await socketAlive()), 5000);

  // Stale socket file left by a crashed daemon: the next daemon must take over
  // and stay up (it used to run onControlReady twice and crash in listenTcp).
  fs.writeFileSync(ENV.LOOP_BRIDGE_SOCK, '');
  const revived = spawn(process.execPath, ['daemon.mjs'], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let revivedLog = '';
  revived.stderr.on('data', (d) => { revivedLog += d; });
  ok('stale socket → daemon takes over', await waitFor(socketAlive));
  ok('stale socket → phone port open', await waitFor(portOpen));
  await sleep(500);
  ok('stale socket → daemon still running', revived.exitCode === null);
  ok('stale socket → ready logged once', (revivedLog.match(/ready on/g) ?? []).length === 1);
  await control({ op: 'shutdown' });
  await waitFor(async () => revived.exitCode !== null, 3000);
} finally {
  for (const s of shims) s.kill();
  phoneSocket?.destroy();
  await control({ op: 'shutdown' }).catch(() => {});
  await sleep(200);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
