#!/usr/bin/env node
// E2E self-test: drives bridge/server.mjs as an MCP client (stdio) and as a
// fake phone (TCP). Isolated port + state file — safe to run anywhere.
// Usage: node test.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PORT = 18766;
const STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-bridge-')), 'state.json');
const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, LOOP_BRIDGE_PORT: String(PORT), LOOP_BRIDGE_STATE: STATE },
});

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

// ── MCP client side (child stdio) ──
const mcpPending = new Map();
let mcpNext = 1;
const mcpLines = readline.createInterface({ input: server.stdout });
mcpLines.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id !== null && mcpPending.has(m.id)) { mcpPending.get(m.id)(m); mcpPending.delete(m.id); }
});
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = mcpNext++;
    mcpPending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ── fake phone side (TCP, lazy — bridge needs a moment to listen) ──
let phoneSocket = null;
let phoneGot = null;               // last {invoke} from bridge
const phoneWaiters = [];
let last = null;                   // most recent phone-side message
let issuedSecret = null;

async function connectPhone() {
  phoneSocket = await new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      const s = net.connect(PORT, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        if (n > 40) reject(new Error('bridge tcp listener never came up'));
        else setTimeout(() => tryOnce(n + 1), 150);
      });
    };
    tryOnce(0);
  });
  phoneSocket.setEncoding('utf8');
  phoneSocket.on('error', () => {});
  const rl = readline.createInterface({ input: phoneSocket });
  rl.on('line', (l) => {
    const m = JSON.parse(l);
    last = m;
    if (m.t === 'paired' && m.secret) issuedSecret = m.secret;
    if (m.t === 'invoke') {
      if (phoneWaiters.length) phoneWaiters.shift()(m);
      else phoneGot = m;
    }
  });
}
const toPhone = (o) => phoneSocket.write(JSON.stringify(o) + '\n');
const awaitInvoke = () => {
  if (phoneGot) {
    const g = phoneGot;
    phoneGot = null;
    return Promise.resolve(g);
  }
  return new Promise((r) => phoneWaiters.push(r));
};

// ── scenario ──
const deviceId = 'test-phone-' + Date.now();
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  ok('initialize → serverInfo', init.result?.serverInfo?.name === 'loop');
  ok('initialize → echoes requested protocolVersion', init.result?.protocolVersion === '2025-06-18');

  const list = await rpc('tools/list', {});
  const names = list.result?.tools?.map((t) => t.name);
  ok('tools/list → 6 tools', names?.length === 6);
  ok('tools/list → relay+bridge tools present',
    ['search_logs', 'get_log', 'get_chain', 'logs_on_day', 'bridge_status', 'pairing_code']
      .every((n) => names.includes(n)));

  // unpaired search → isError with guidance
  const s0 = await rpc('tools/call', { name: 'search_logs', arguments: { query: 'x' } });
  ok('search without phone → isError', s0.result?.isError === true);

  await connectPhone();

  // phone hello (new device) → need_code
  toPhone({ t: 'hello', id: deviceId, proto: 1 });
  await new Promise((r) => setTimeout(r, 300));
  const hello1 = await lastPhoneMsg();
  ok('hello (new) → need_code', hello1?.t === 'need_code');

  // pairing code via MCP
  const codeRes = await rpc('tools/call', { name: 'pairing_code', arguments: {} });
  const code = codeRes.result?.content?.[0]?.text?.match(/(\d{8})/)?.[1];
  ok('pairing_code → 8 digits', !!code);

  // wrong code once → attemptsLeft
  toPhone({ t: 'pair', code: '00000000' });
  await new Promise((r) => setTimeout(r, 300));
  ok('wrong code → need_code + attemptsLeft', (await lastPhoneMsg())?.attemptsLeft === 4);

  // correct code → paired + secret
  toPhone({ t: 'pair', code });
  await new Promise((r) => setTimeout(r, 300));
  const paired = await lastPhoneMsg();
  ok('pair → paired + secret', paired?.t === 'paired' && typeof paired.secret === 'string' && paired.secret.length >= 40);
  issuedSecret = paired.secret;

  // state file persisted
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('state.json → device saved', saved.devices.some((d) => d.id === deviceId));

  // relay: search_logs
  const searchP = rpc('tools/call', { name: 'search_logs', arguments: { query: '망원경' } });
  const inv = await awaitInvoke();
  ok('bridge → invoke on phone', inv?.tool === 'search_logs' && inv.args.query === '망원경');
  toPhone({ t: 'result', rid: inv.rid, ok: true, text: '가짜검색결과 3건' });
  const search = await searchP;
  ok('search_logs → relayed text', search.result?.content?.[0]?.text === '가짜검색결과 3건' && !search.result.isError);

  // relay: phone-side error
  const errP = rpc('tools/call', { name: 'get_log', arguments: { id: 'nope' } });
  const inv2 = await awaitInvoke();
  toPhone({ t: 'result', rid: inv2.rid, ok: false, error: 'No such log: nope' });
  const errRes = await errP;
  ok('phone error → isError with message', errRes.result?.isError === true && errRes.result.content[0].text.includes('No such log'));

  // status shows connected
  const st = await rpc('tools/call', { name: 'bridge_status', arguments: {} });
  ok('bridge_status → connected', st.result?.content?.[0]?.text.includes('Phone connected'));

  // disconnect → next search fails gracefully
  phoneSocket.destroy();
  await new Promise((r) => setTimeout(r, 300));
  const s1 = await rpc('tools/call', { name: 'search_logs', arguments: { query: 'x' } });
  ok('search after disconnect → isError', s1.result?.isError === true);

  // unknown method
  const bad = await rpc('no/such', {});
  ok('unknown method → -32601', bad.error?.code === -32601);
} finally {
  server.kill();
  phoneSocket.destroy();
  fs.rmSync(path.dirname(STATE), { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// crude helper: most recent phone-side message (tests are sequential)
function lastPhoneMsg() {
  return Promise.resolve(last);
}
