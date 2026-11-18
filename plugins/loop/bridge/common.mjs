// Shared constants for the Loop bridge daemon (daemon.mjs) and the per-session
// MCP shim (server.mjs). Zero dependencies, node >= 18.

import os from 'node:os';
import path from 'node:path';

/** Bridge version. A shim that is newer than the running daemon replaces it. */
export const VERSION = '1.2.1';

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
