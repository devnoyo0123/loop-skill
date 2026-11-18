# Loop Journal Skill

A [Claude Code](https://claude.com/claude-code) plugin that connects Claude to the
[Loop](https://devnoyo0123.github.io/loop-guide/) journal app on your phone — through
a bundled **bridge** MCP server. Install once; the phone pairs with an 8-digit code
and reconnects automatically. Search your journal, build morning notes and reviews,
all read-only, all on your local network.

```
Claude Code session A ─ stdio ─ shim ─┐
Claude Code session B ─ stdio ─ shim ─┼─ local socket ─ bridge daemon ─ LAN ─ Loop app
Claude Code session C ─ stdio ─ shim ─┘                                  (data stays on the phone)
```

Every Claude Code session gets a thin shim; one shared bridge daemon (started
on demand, exits 10 min after the last session closes) holds the phone link
and the pairing code. So pairing and searching work from any session.

## Requirements

- [Loop](https://devnoyo0123.github.io/loop-guide/) Android app with the **PC 연결**
  feature · Claude Code · node ≥ 18 · phone and computer on the same network

## Install (plugin, one command)

```
/plugin marketplace add devnoyo0123/loop-skill
/plugin install loop@loop
```

The MCP server (`mcp__loop__*` tools) registers automatically with the plugin —
no `claude mcp add`, no IP or token setup.

## Install (manual, personal skill)

```bash
mkdir -p ~/.claude/skills
cp -R plugins/loop/skills/journal ~/.claude/skills/journal
```

Note: the manual path installs the skill instructions only — the bundled MCP
bridge needs the plugin install above.

## Usage

Open Loop → Settings → **PC 연결** on the phone and connect to your computer
(auto-discovered, or enter its IP — port 8766). First time, Claude shows an
8-digit pairing code via the `pairing_code` tool; type it into the phone. Then:

```
내 Loop 기록에서 "독서" 관련 내용 찾아줘
Search my Loop logs about procrastination
/loop:journal          ← or /journal — full connect → verify → search workflow
```

## Development

```bash
cd plugins/loop/bridge
node test.mjs          # 28-check E2E: 2 sessions, shared daemon, pairing, upgrade
```

- `plugins/loop/bridge/server.mjs` — per-session MCP shim (stdio, zero-dependency node)
- `plugins/loop/bridge/daemon.mjs` — shared bridge daemon: phone TCP link (port 8766),
  pairing, control socket `~/.loop-bridge/bridge.sock`, log `~/.loop-bridge/daemon.log`
- Design: `docs/mcp-bridge-design.md` · decision: `docs/adr-002-desktop-mcp-bridge.md`
  in the Loop app repo

## 한국어

Loop(루프) 앱과 Claude를 연결하는 Claude Code 플러그인입니다. 설치하면 MCP
서버가 자동으로 등록되고, 폰에서 "PC 연결"로 맥을 잡은 뒤 최초 1회 8자리
코드만 입력하면 끝 — 이후 자동 재연결됩니다. 기록은 폰을 벗어나지 않고
검색 질의·응답만 로컬 네트워크로 오갑니다.
