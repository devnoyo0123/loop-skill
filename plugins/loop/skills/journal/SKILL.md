---
name: journal
description: Connect to the Loop journal app through the Loop bridge and search the user's journal logs. Use when the user asks to read or search their Loop records, build a morning note or weekly/monthly review from them, continue a log chain, or pair/troubleshoot the phone connection. Trigger words include Loop, 루프, 기록, 아침 노트, 회고.
allowed-tools: Bash(node *) Bash(ipconfig getifaddr *)
---

# Loop journal access

Loop is a local-first journaling Android app. This plugin ships a **bridge**: an
MCP server the user's phone connects to as a client. Nothing is uploaded —
queries and results stay on the local network, and the journal data stays on
the phone.

Tools appear as `mcp__loop__*` automatically once the plugin is installed. No
`claude mcp add`, no IP, no token copying.

## Server tools

- `search_logs` — full-text search over content and place (FTS5 trigram, 3+
  characters). Args: `query` (required), `limit`, `from` / `to` (YYYY-MM-DD,
  inclusive, local time), `order` (`recent` | `relevance`, default `recent`).
  Returns snippets with matches wrapped in `**`; fetch full text with
  `get_log` or `get_chain`.
- `get_log` — one log in full, with metadata. Args: `id`.
- `get_chain` — the whole chain (original log and all follow-ups) containing
  the given id, oldest first. Args: `id` (any log id in the chain).
- `logs_on_day` — all logs written on one day, oldest first. Args: `date`
  (YYYY-MM-DD).

## Bridge tools

- `bridge_status` — phone link state. Call this first whenever a search tool
  reports the phone is not connected.
- `pairing_code` — 8-digit code for a phone waiting to pair. Present the code
  to the user in chat; they type it into the phone.

## Workflow

1. **Try the request directly.** If the phone is linked, search tools just
   work — skip to Collect below.
2. **If not connected**, call `bridge_status` — it includes this Mac's LAN
   address for the phone. If it doesn't, get the address yourself with
   `ipconfig getifaddr en0`. **Never ask the user to find their IP.** Tell
   them exactly what to type, e.g.:
   `폰에서 Loop → 설정 → PC 연결 을 열고 이 주소를 입력하세요: 192.168.35.8`
   and remind them to keep the app in the foreground while using it.
3. **If the phone asks for a code** (first pairing), call `pairing_code` and
   show the 8 digits prominently, e.g. `폰에 입력: 5832 9417`. Pairing is
   once; afterwards the phone reconnects automatically.
4. **Collect**: run the searches the request needs. Widen with `from`/`to`
   windows, then `get_chain` on the ids that look most relevant so replies
   keep their context.
5. **Organize**: deliver what was asked for — a note, a review, an answer —
   **in the user's language**. Quote sparingly; these are private logs.

## Common requests

- **Morning note / 아침 노트**: `logs_on_day` for yesterday and today, plus
  `search_logs` for themes that recur across recent days; end with one or two
  concrete prompts for today.
- **Weekly or monthly review / 회고**: `search_logs` over the period (several
  narrow queries beat one broad one), `get_chain` on the most repeated topics,
  then a summary grouped by theme with dates.
- **"What did I write about X"**: `search_logs` with query X, then `get_log`
  on the top hits.
- **Continuity**: given any log id, `get_chain` to show the original and its
  continuations in order.
- **Empty results**: try shorter or alternative keywords, Korean-English
  variants, or a `logs_on_day` sweep over likely dates.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| No `mcp__loop__*` tools at all | Plugin not enabled or `node` (≥18) missing — check `/plugin` and `node -v` |
| Search says "Phone not connected" | Phone not linked → phone app → PC 연결, keep app in foreground |
| Phone can't find the Mac | Auto-discovery missed → enter the Mac IP manually: `ipconfig getifaddr en0`, port 8766 |
| "Port 8766 is held by another program" | Usually an older Loop plugin (< 1.2) still running in another Claude Code session — update the plugin and restart that session; the bridge takes the port over by itself |
| Bridge won't start | Check `~/.loop-bridge/daemon.log` |
| "did not answer within 30s" | Phone app backgrounded or locked → bring Loop to the foreground and retry |
| Firewall prompt on first run | Allow incoming connections for node — the phone initiates, the Mac accepts |
| Phone was reinstalled / new device | Old pairing invalid — pair again with a fresh `pairing_code` |

If troubleshooting fails, have the user check the phone's connection screen
before guessing further.
