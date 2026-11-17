# Loop Journal Skill

A [Claude Code](https://claude.com/claude-code) plugin that connects Claude to the
[Loop](https://devnoyo0123.github.io/loop-guide/) journal app's local MCP server.
Install it, toggle the server on in the app, and Claude can search your journal
logs, build morning notes and reviews from them, and walk you through connection
troubleshooting — all read-only, all on your local network.

## Requirements

- The Loop Android app with the MCP server feature (Settings → MCP server)
- Claude Code on macOS, Windows, or Linux
- Phone and computer on the same network (home Wi-Fi, or a phone hotspot)

## Install (plugin, one command)

```
/plugin marketplace add devnoyo0123/loop-skill
/plugin install loop@loop
```

## Install (manual, personal skill)

Copy the skill folder into your personal skills directory:

```bash
mkdir -p ~/.claude/skills
cp -R plugins/loop/skills/journal ~/.claude/skills/journal
```

## Usage

Start the MCP server in Loop (Settings → MCP server → toggle on), then in Claude Code:

```
내 Loop 기록에서 "독서" 관련 내용 찾아줘
Search my Loop logs about procrastination
/loop:journal          ← or /journal — walks through connect → verify → search
```

Claude handles registration (`claude mcp add`), verification, searching
(`search_logs`, `logs_on_day`), pulling full chains (`get_chain`), and common
failure diagnosis (AP isolation, macOS local-network permission, token
regeneration, DHCP IP changes).

## Structure

```
.claude-plugin/marketplace.json   ← marketplace: lists the plugin
plugins/loop/                     ← the plugin
├── .claude-plugin/plugin.json
└── skills/journal/SKILL.md       ← the skill
```

## Repository

Loop app: [devnoyo0123/loop](https://github.com/devnoyo0123/loop) ·
Design docs: `docs/adr-001-local-mcp-server.md`, `docs/mcp-design.md`

## 한국어

Loop(루프) 앱의 로컬 MCP 서버에 Claude를 연결하는 Claude Code 플러그인입니다.
앱 설정 → MCP 서버를 켜고, Claude Code에서 위의 설치 명령 두 줄만 입력하면
기록 검색·아침 노트·회고 작성·연결 문제 진단을 바로 쓸 수 있습니다. 읽기 전용이며
기록은 네트워크 밖으로 나가지 않습니다.
