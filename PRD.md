# CodexScope PRD

## 1. Product

CodexScope is a lightweight desktop dashboard for developers who use Codex locally and want a quick view of token usage, model mix, API-value estimates, account usage, rate-limit state, and tool-call activity.

It runs as a menu-bar / system-tray app and reads local Codex data without changing Codex configuration or session history.

## 2. Target Users

- Developers who run Codex Desktop or Codex CLI frequently
- Users who want to understand which models, reasoning efforts, and tools dominate their Codex workflow
- Subscription users who want an approximate API-value view even though their real billing is subscription/quota based
- Power users who need quick visibility into rate-limit windows and manual reset credits

## 3. Core Jobs

- Show current-day token volume without opening a terminal
- Compare Day / Week / Month usage trends
- Explain token split between uncached input, cached input, and output
- Attribute usage to actual model IDs instead of product-surface labels
- Show equivalent API value using public pricing, while making clear that it is not a subscription bill
- Show top Codex tool calls and long-term profile stats
- Surface rate-limit and reset-credit status when the local Codex account interface allows it

## 4. Data Sources

| Data | Source | Notes |
| --- | --- | --- |
| Tokens | `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/*.jsonl` | Read-only local files |
| Session/model state | `session_meta` and `turn_context` JSONL events | Used to bind token events to sessions, model IDs, and reasoning effort |
| Tool calls | `response_item` events | Supports function calls, web search, tool search, and other `*_call` events |
| Account usage | `codex app-server --stdio`, `account/usage/read` | Used for profile and heatmap when available |
| Rate limits | `codex app-server --stdio`, `account/rateLimits/read` | Used for primary/weekly quota windows |
| Reset credits | ChatGPT reset-credit endpoint with local Codex auth | Used only to read available credits and expiry |
| Prices | `models.dev`, LiteLLM, bundled snapshot | Cached locally with offline fallback |

## 5. Dashboard Scope

- Total tokens
- Input / cached input / output split
- Estimated API value
- Responses and thread count
- Tokens by model
- API value by model
- Usage left and reset credits
- Profile stats: all tokens, peak day, longest thread, streak, top effort, thread count, tool runs
- Top tool calls
- Daily activity heatmap

## 6. Non-Goals

- Editing Codex settings
- Uploading local session logs
- Claiming to show real ChatGPT subscription billing
- Replacing Codex's own quota enforcement
- Shipping notarized binaries before signing infrastructure exists

## 7. Release Policy

The project is MIT-licensed and adapted from `HduSy/tokenscope`. Public releases must preserve the original MIT license notice and include clear attribution in README and NOTICE.
