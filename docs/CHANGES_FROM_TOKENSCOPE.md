# Changes From Tokenscope

CodexScope keeps the original Tauri + React desktop app shape from
`HduSy/tokenscope`, but changes the product surface from Claude CLI usage to
Codex usage.

## Product Changes

- Renamed the app, package, bundle title, cache directory, and visual accent to CodexScope
- Replaced Claude project-log parsing with Codex rollout JSONL parsing
- Replaced MCP / Skill breakdowns with Codex tool-call activity
- Added Codex account usage and rate-limit cards
- Added manual reset-credit availability and earliest expiry display
- Added profile stats for all-time tokens, peak day, longest thread, usage streaks, top reasoning effort, thread count, and tool runs
- Added dashboard screenshot export
- Tuned macOS popover positioning for multi-monitor and notched-display setups

## Data Changes

- Reads `~/.codex/sessions/**/rollout-*.jsonl`
- Reads `~/.codex/archived_sessions/*.jsonl`
- Uses `session_meta` and `turn_context` to recover session, model, and reasoning effort for token events
- Uses `codex app-server --stdio` for account usage and public rate-limit summaries when available
- Uses local Codex auth to read reset-credit expiry when the endpoint is reachable

## License

The original project is MIT-licensed. CodexScope preserves the original license
text and copyright notice in `LICENSE`, adds project attribution in `NOTICE`,
and is published under the same MIT terms.
