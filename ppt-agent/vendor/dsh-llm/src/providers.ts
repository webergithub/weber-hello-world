/**
 * PPT_Agent v3.15：常见大模型服务的预设（只用于“选择服务商”时一键填入接口地址 / 协议 / 模型候选；没有默认值）。
 * 协议：messages = Anthropic Messages 兼容（Harness 原生传输），openai = OpenAI Chat Completions 兼容。
 * 模型名会随服务商更新，界面上可直接修改。
 */
export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic Claude', protocol: 'messages', baseURL: 'https://api.anthropic.com', models: [] },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'messages', baseURL: 'https://api.deepseek.com/anthropic', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', name: '通义千问（阿里云百炼）', protocol: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'] },
  { id: 'kimi', name: 'Kimi（月之暗面）', protocol: 'openai', baseURL: 'https://api.moonshot.cn/v1', models: ['kimi-k2-turbo-preview', 'moonshot-v1-32k'] },
  { id: 'doubao', name: '豆包（火山方舟）', protocol: 'openai', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6', 'doubao-1-5-pro-32k'] },
  { id: 'siliconflow', name: '硅基流动', protocol: 'openai', baseURL: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen3-32B', 'deepseek-ai/DeepSeek-V3'] },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseURL: 'https://api.openai.com/v1', models: ['gpt-4.1', 'gpt-4o-mini'] },
  { id: 'ollama', name: '本机 Ollama', protocol: 'openai', baseURL: 'http://localhost:11434/v1', models: ['qwen3:8b', 'llama3.1:8b'], noKey: true },
  { id: 'custom', name: '自定义（其他兼容接口）', protocol: 'openai', baseURL: '', models: [] },
]
