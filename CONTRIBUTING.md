# Contributing to CodexScope

Thanks for taking the time to improve CodexScope.

CodexScope is an MIT-licensed adaptation of
[HduSy/tokenscope](https://github.com/HduSy/tokenscope). Please keep that
attribution intact when changing docs, screenshots, packaging, or project
metadata.

## Development Setup

Prerequisites:

- Node.js 22 or newer
- pnpm 10 or newer
- Rust stable
- Platform tooling required by Tauri 2

Install dependencies:

```bash
pnpm install
```

Run the desktop app in development:

```bash
pnpm tauri dev
```

Run a frontend-only preview with a real local data snapshot:

```bash
cd src-tauri
cargo run --example dump > ../public/dev-dashboard.json
cd ..
pnpm dev
```

## Checks

Before opening a pull request, run the checks that match your change:

```bash
pnpm build
cd src-tauri
cargo fmt --check
cargo check
```

For pricing changes, also run:

```bash
cd src-tauri
cargo test pricing::tests::builtin_prices_openai_official_models_without_network
```

## Pull Requests

- Keep changes focused and explain the user-visible effect.
- Include screenshots for UI changes.
- Do not commit `public/dev-dashboard.json`; it is local preview data.
- Avoid changing package identity, license, attribution, or release workflow
  behavior unless the PR is specifically about those areas.
- Treat local Codex logs and account data as private. Do not paste real
  personal logs into issues or PRs.

## Reporting Issues

When filing a bug, include:

- OS and version
- CodexScope version or commit
- Whether you are using a built app or `pnpm tauri dev`
- Relevant console output or error text
- A screenshot if the issue is visual

Please redact user names, paths, API keys, account IDs, and private Codex
session content before posting.
