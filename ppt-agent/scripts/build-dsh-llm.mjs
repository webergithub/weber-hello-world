// 把 vendor/dsh-llm（DeepSeek Harness 的大模型接入层源码 + PPT_Agent 的精简适配器）编译成主进程使用的 CommonJS：
// electron/core/ppt_agent/dsh-llm.cjs（已提交；修改 vendor 后运行 npm run build:dsh 重新生成）。
import { build } from 'rolldown'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v = (p) => path.join(root, 'vendor/dsh-llm', p)
await build({
  input: v('index.ts'),
  platform: 'node',
  resolve: { alias: {
    '@deepseek-ai/dsh-llm': v('src/shims/dsh-llm.ts'),
    '@deepseek-ai/dsh-brand': v('upstream/brand/index.ts'),
  } },
  output: {
    file: path.join(root, 'electron/core/ppt_agent/dsh-llm.cjs'), format: 'cjs', sourcemap: false,
    banner: '/* 由 scripts/build-dsh-llm.mjs 从 vendor/dsh-llm 生成，请勿手工修改。包含 DeepSeek Harness（MIT，Copyright (c) 2026 DeepSeek）与 eventsource-parser（MIT）的代码。 */',
  },
})
console.log('built electron/core/ppt_agent/dsh-llm.cjs')
