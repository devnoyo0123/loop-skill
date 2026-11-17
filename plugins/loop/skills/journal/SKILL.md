---
name: journal
description: Connect to the Loop journal app's local MCP server and search the user's journal logs. Use when the user asks to read or search their Loop records, build a morning note or weekly/monthly review from them, continue a log chain, or fix a Loop MCP connection. Trigger words include Loop, 루프, 기록, 아침 노트, 회고.
allowed-tools: Bash(claude mcp *)
---

# Loop journal access

Loop is a local-first journaling Android app. It embeds a **read-only** MCP server (Streamable HTTP, Bearer token) that runs only while the user toggles it on in the app, on the same Wi-Fi as this machine. Nothing is uploaded anywhere — this machine's agent is the only consumer.

## Server tools (read-only)

Once the server named `loop` is registered, its tools appear as `mcp__loop__*`:

- `search_logs` — full-text search over content and place (FTS5 trigram, 3+ characters). Args: `query` (required), `limit`, `from` / `to` (YYYY-MM-DD, inclusive, local time), `order` (`recent` | `relevance`, default `recent`). Returns snippets with matches wrapped in `**`; fetch full text with `get_log` or `get_chain`.
- `get_log` — one log in full, with metadata. Args: `id`.
- `get_chain` — the whole chain (original log and all follow-ups) containing the given id, oldest first. Args: `id` (any log id in the chain).
- `logs_on_day` — all logs written on one day, oldest first. Args: `date` (YYYY-MM-DD).

## Workflow

1. **Check for an existing registration**: run `claude mcp list`. If a server named `loop` shows as connected, skip to step 4.
2. **Ask the user to start the server on the phone**: Loop → Settings → MCP server → toggle on, on the same Wi-Fi as this machine (a phone hotspot works too — connect this machine to it). The app screen shows the exact connection command.
3. **Register** — never invent an IP or token. Two ways to get the values:
   the user pastes the copied command from the app screen, or reads the URL
   and token aloud from it (tap the eye icon to reveal the 43-character
   token). Assemble from those values:
   ```bash
   claude mcp remove loop -s user 2>/dev/null; claude mcp add --transport http -s user loop http://<phone-ip>:8765/mcp --header "Authorization: Bearer <token>"
   ```
4. **Verify**: `claude mcp list` shows `loop` as connected. A registration made
   during this session does not load into it — if the `mcp__loop__*` tools are
   missing, tell the user to restart Claude Code (or run `/mcp`) and continue
   in the next session. Once loaded, probe with `logs_on_day` for today.
5. **Collect**: run the searches the request needs. Widen with `from`/`to` windows, then pull `get_chain` on the ids that look most relevant so replies keep their context.
6. **Organize**: deliver what was asked for — a note, a review, an answer — **in the user's language**. Quote sparingly; these are private logs.

## Common requests

- **Morning note / 아침 노트**: `logs_on_day` for yesterday and today, plus `search_logs` for themes that recur across recent days; end with one or two concrete prompts for today.
- **Weekly or monthly review / 회고**: `search_logs` over the period (several narrow queries beat one broad one), `get_chain` on the most repeated topics, then a summary grouped by theme with dates.
- **"What did I write about X"**: `search_logs` with query X, then `get_log` on the top hits.
- **Continuity**: given any log id, `get_chain` to show the original and its continuations in order.
- **Empty results**: try shorter or alternative keywords, Korean-English variants, or a `logs_on_day` sweep over likely dates.

## Troubleshooting

The server auto-shuts down after 30 minutes (extendable in the app) and is read-only.

| Symptom | Cause → Fix |
|---|---|
| `claude mcp list` shows failed or timeout | Server off or 30 min elapsed → re-toggle in the app. IP changed (DHCP) → re-copy the command from the app screen |
| Connection refused | Phone and this machine on different networks → same Wi-Fi, or connect this machine to the phone's hotspot |
| Timeout on macOS with everything else fine | macOS local-network permission → System Settings → Privacy & Security → Local Network → allow the terminal app |
| Guest, office, or dorm Wi-Fi never connects | Router AP isolation blocks device-to-device traffic → switch to the phone's hotspot or a home network |
| 401 Unauthorized | Token mismatch — 5 failed attempts auto-regenerates the token → re-copy the command from the app screen |
| Phone shows no access attempts at all | Server not actually reachable — check both devices are on Wi-Fi, then use the app's connection FAQ screen (Settings → MCP server), which opens the matching guide entry |

If troubleshooting fails, point the user at the app's FAQ screen rather than guessing further.
