# vendor/dsh-llm — DeepSeek Harness 大模型接入层（拷贝复用）

- 来源：https://github.com/deepseek-ai/deepseek-harness ，commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（2026-11-04），MIT License（见 `LICENSE`，Copyright (c) 2026 DeepSeek）。
- `upstream/` 下为**原样拷贝**的文件（未修改）：
  - `llm-deepseek/`：`messages-api.ts`、`transport.ts`、`sse.ts`、`translate.ts`、`replay.ts`、`wire-types.ts`、`defaults.ts`（packages/llm/llm-deepseek/src）
  - `llm/error.ts`、`llm/brand.ts`（packages/llm/llm/src）；`llm/llm-error.ts` 为 packages/llm/llm/src/index.ts 第 80–131 行（`LlmErrorOptions` / `LlmError`）的原样摘录，另补了 import 与本地 `LlmFailure` 类型声明
  - `timeout/index.ts`（packages/util/timeout/src/index.ts）、`brand/index.ts`（packages/util/brand/src/index.ts）
- `src/` 为 PPT_Agent 的适配代码：
  - `shims/dsh-llm.ts`：代替 `@deepseek-ai/dsh-llm`，只导出拷贝文件用到的符号
  - `retry.ts`：重试默认值来自 `packages/llm/llm/src/retry-policy.ts`，`localDelay` 原样来自 `packages/llm/llm-retry/src/index.ts`
  - `client.ts`：按 `packages/llm/llm-deepseek/src/adapter.ts` 的 `generate()` / `request()` 裁剪出的纯文本客户端（去掉 cordis 插件装配、Files API / 图片、请求扩展、工具调用、账号鉴权；增加整次请求的重试）
- 构建：`npm run build:dsh`（`scripts/build-dsh-llm.mjs`，rolldown）→ `electron/core/ppt_agent/dsh-llm.cjs`（已提交，主进程直接 require）。`eventsource-parser`（MIT）一并打包进去。
- 升级：重新拷贝 `upstream/` 中的文件后运行 `npm run build:dsh` 与 `npm test`。
