# CodexScope

[English](README.md) · 中文

![CodexScope 面板](docs/screenshot.png)

CodexScope 是一个 macOS 菜单栏 / Windows 系统托盘应用，用来查看本机 Codex token 用量、API 等效价值估算、模型分布、工具调用、账号使用概览和当前 rate limit 状态。

技术栈：Tauri 2 + React + TypeScript 前端，Rust 数据层。

CodexScope 基于 MIT 协议的 [HduSy/tokenscope](https://github.com/HduSy/tokenscope) 改编。原项目面向 Claude CLI 用量分析；本项目保留它的桌面应用结构和面板视觉结构，把数据层替换为 Codex rollout 日志解析和 Codex 账号 / rate limit 数据读取。

## 功能

- 在菜单栏 tooltip / 托盘标签中展示今日 Codex token 用量
- 点击打开面板，支持 Day / Week / Month 切换
- 展示 total tokens、input / cached input / output 拆分、responses、threads、API 等效价值估算
- 展示模型 token 分布、按模型估算价值、Codex 工具调用排行
- 当 `codex app-server` 可用时展示账号画像：累计 token、峰值日、最长线程、连续使用天数、最常用 reasoning effort、线程数和工具调用数
- 展示 rate-limit 卡片：主窗口剩余额度、周窗口概览、可用手动 reset 次数，以及能读取到时的最近 reset credit 到期时间
- 展示保留历史窗口内的每日活跃热力图
- 支持 System / Dark / Light 主题切换
- 支持一键把当前面板截图保存到桌面
- 针对 macOS 刘海屏和多显示器场景优化菜单栏弹窗定位

## 数据源

| 用途 | 来源 |
| --- | --- |
| Token 和工具调用 | `~/.codex/sessions/**/rollout-*.jsonl` |
| 已归档会话 | `~/.codex/archived_sessions/*.jsonl` |
| 模型和 reasoning effort | rollout JSONL 中最近的 `turn_context` |
| 账号用量概览 | `codex app-server --stdio` 的 `account/usage/read` |
| rate-limit 窗口 | `codex app-server --stdio` 的 `account/rateLimits/read` |
| 手动 reset credit 到期时间 | 可用时使用本机 Codex auth 读取 ChatGPT reset-credit 接口 |
| 模型价格 | OpenAI/Codex 模型优先使用 OpenAI 公开 API 价格，再兜底 `models.dev`、LiteLLM 和内置快照 |
| 本地缓存 | macOS 下 `~/Library/Caches/codexscope/` |

CodexScope 对 Codex 会话日志只读。它读取本地 JSONL 和 Codex 账号元数据，不修改 Codex 配置或会话历史。

## 核心处理逻辑

- 首次扫描后采用增量读取，只处理 JSONL 新追加的字节，并把压缩后的事件写入 app 缓存
- 解析器跟踪 `session_meta` 和 `turn_context`，让后续 token 事件继承正确的 session、model 和 reasoning effort
- 如果增量读取从文件中间开始，会先回扫已读前缀，找最近的 `turn_context` 作为状态种子，避免把活跃会话的新 token 误归为 unknown
- `codex` 这种产品面 fallback 不会当作模型名展示；缺失模型会明确归为 unknown
- 工具调用来自 `response_item` 中的 `function_call`、`web_search_call`、`tool_search_call` 和其他 `*_call` 事件
- Day / Week / Month 按自然日、自然周、自然月聚合，并与上一对应周期比较 token 和价值变化
- 当 Codex app-server 的账号用量可用时，all-time profile 和每日热力图优先采用账号数据；否则使用本机保留日志估算
- rate-limit 单独缓存，刷新失败时仍能展示上一次可用状态

> API value 对已公开价格的 OpenAI/Codex 模型优先使用 OpenAI 官方 API 价格估算；第三方公开价格表只作为兜底。它不等于 ChatGPT/Codex 订阅账单或 quota 规则。

## Token 类型与估算公式

Codex `token_count` 事件包含：

| 阶段 | Codex 字段 | UI 展示 |
| --- | --- | --- |
| 输入 | `input_tokens - cached_input_tokens` | Input |
| 缓存命中 | `cached_input_tokens` | Cached input |
| 输出 | `output_tokens` | Output |
| 推理输出 | `reasoning_output_tokens` | 信息字段，不重复加总 |

UI 中展示的总量：

```text
total = input + cached_input + output
```

API 等效价值估算会匹配最接近的价格条目。对 OpenAI 已公开 API 价格的 Codex/OpenAI 模型，CodexScope 优先使用标准处理、短上下文价格：

```text
value = input        * price.input
      + cache_read   * price.cache_read
      + output       * price.output
```

当前 CodexScope 消费的 Codex 事件没有单独暴露 cache write，因此 cache creation 保持为 0，等未来日志提供后再接入。长上下文、Batch、Flex、Priority、数据驻留加价以及 ChatGPT 订阅账单都可能和这个估算不同。

## 安装

目前还没有正式公开 release，可先从源码本地构建。

### macOS

```bash
pnpm install
pnpm tauri build
open src-tauri/target/release/bundle/macos/CodexScope.app
```

如果 macOS 拦截未签名构建：

```bash
xattr -cr src-tauri/target/release/bundle/macos/CodexScope.app
open src-tauri/target/release/bundle/macos/CodexScope.app
```

### Windows

```bash
pnpm install
pnpm tauri build
```

NSIS 安装包会输出到 `src-tauri/target/release/bundle/nsis/`。

## 开发

```bash
pnpm install
pnpm tauri dev
```

仅前端预览，使用实机数据快照：

```bash
cd src-tauri
cargo run --example dump > ../public/dev-dashboard.json
cd ..
pnpm dev
```

## 构建

```bash
pnpm build
pnpm tauri build
```

产物输出在 `src-tauri/target/release/bundle/`。

## 目录结构

```text
src/                       React 前端
  data.ts                  类型、Tauri bridge、主题和格式化
  charts.tsx               图表组件
  App.tsx                  主面板
src-tauri/src/
  store.rs                 增量读取 Codex rollout JSONL
  parser.rs                Day / Week / Month 聚合和 profile stats
  account_usage.rs         Codex app-server 与 reset-credit 刷新
  pricing.rs               OpenAI API 价格优先覆盖 + models.dev / LiteLLM 兜底估算
  model.rs                 返回前端的数据结构
  lib.rs                   Tauri 命令、菜单栏托盘和弹窗行为
```

## 改编声明与许可证

CodexScope 基于 [HduSy/tokenscope](https://github.com/HduSy/tokenscope) 改编。原项目采用 MIT License，原版权声明保留在 [LICENSE](LICENSE)。

本改编版把产品目标从 Claude CLI 用量分析改为 Codex 用量分析，增加了 Codex 账号 / rate-limit 数据读取，更新了 UI 文案、图标和数据语义，并继续按 MIT 协议公开。详见 [NOTICE](NOTICE)。

## 社区

- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全报告：[SECURITY.md](SECURITY.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
