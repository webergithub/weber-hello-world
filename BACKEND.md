# 后台服务端规划 / Backend roadmap

到目前为止，服务端只做了三件事：中继房间消息、代理翻译、代理 Whisper。
这足以让 app 跑起来，但**不足以运营一个真实服务**——没有可观测性、没有成本
保护、没有管理手段。本文规划补齐这些能力，分四个阶段推进。

The server so far only relays rooms, proxies translation, and proxies Whisper.
That runs the app but is not enough to *operate* a real service: no
observability, no cost protection, no way to manage what's happening. This
document plans those capabilities in four phases.

---

## 阶段一：可运营性 Operability ✅ 已完成 (implemented)

先解决「服务跑起来之后，我怎么知道它是否健康、花了多少钱、出了问题怎么处理」。

| 能力 | 实现 |
| --- | --- |
| 健康检查 `/api/health` | 存活/就绪探针，返回 uptime、房间数、在线人数、各后端配置状态。供 k8s / PaaS / 负载均衡使用 |
| 运行指标 `/api/metrics` | JSON 计数器：房间、WebSocket、消息、翻译（命中缓存/走 provider/离线词库/失败）、转写、限流次数 |
| 限流 Rate limiting | 对**花钱的接口**（翻译、Whisper）和建房接口按 IP 令牌桶限流，防止刷量与成本失控 |
| 管理后台 `/admin` | Token 保护的控制台：房间列表、房间详情（最近消息）、关闭房间、实时指标 |
| 安全默认 | **未设置 `ADMIN_TOKEN` 时管理后台完全关闭**（返回 503），绝不默认裸奔 |

## 阶段二：管控与防滥用 Control & safety

| 能力 | 说明 |
| --- | --- |
| 房主权限 | 锁定房间（禁止新人加入）、移出成员、设置人数上限 |
| 内容限流 | 单房间消息频率、单条长度、单人并发转写数 |
| 结构化日志 | 分级访问日志（`LOG_LEVEL`），便于接入 ELK / Loki |
| 审计 | 管理操作（关闭房间等）留痕 |

## 阶段三：身份与可扩展存储 Identity & storage

| 能力 | 说明 |
| --- | --- |
| 稳定身份 | 设备令牌，重连后仍是同一个人（当前重连会分配新 id） |
| 可插拔存储 | 把现在的 JSON 快照抽象成 store 接口，可换 SQLite / Redis |
| 多实例 | Redis pub/sub 承载中继，突破单进程上限，支持水平扩容 |

## 阶段四：运营与集成 Operations & integration

| 能力 | 说明 |
| --- | --- |
| 用量计量 | 按房间/组织统计翻译字符数与转写秒数，支持配额 |
| 会话导出 | 导出整场对话（JSON / 纯文本），含保留期策略 |
| Webhook | 房间创建/结束事件推送到外部系统 |

---

## 阶段一使用说明 (Phase 1 usage)

### 健康检查

```bash
curl localhost:3000/api/health
# {"status":"ok","uptimeSec":42,"rooms":2,"members":5,
#  "translate":{"provider":"mymemory","offlineOnly":false},
#  "whisper":{"configured":true,"mock":false}}
```

`status` 为 `ok`；进程正在优雅关闭时返回 `shutting_down` + HTTP 503，
方便负载均衡摘除流量。

### 指标

```bash
curl localhost:3000/api/metrics
```

返回累计计数器（进程内，重启清零）。翻译一项区分
`cacheHits` / `provider` / `offline` / `untranslated` / `failures`，
可直接看出缓存命中率与外部服务可用性。

### 限流

按 IP 令牌桶，超限返回 `429` 与 `Retry-After`。默认值可用环境变量调整：

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `RATE_TRANSLATE_PER_MIN` | 每 IP 每分钟翻译请求 | 240 |
| `RATE_TRANSCRIBE_PER_MIN` | 每 IP 每分钟转写请求 | 60 |
| `RATE_ROOMS_PER_MIN` | 每 IP 每分钟建房 | 60 |
| `RATE_LIMIT` | 设为 `0` 全局关闭限流 | 开启 |

> 注意：限流按 IP 计。若所有手机经同一 NAT 出口访问，请调高阈值。

### 管理后台

```bash
ADMIN_TOKEN=$(openssl rand -hex 24) npm start
# 浏览器打开 http://localhost:3000/admin ，粘贴 token
```

- **未设置 `ADMIN_TOKEN` → 后台停用**，所有 `/api/admin/*` 返回 503。
- Token 通过 `Authorization: Bearer <token>` 校验，页面把它存在
  `sessionStorage`（关标签页即失效）。
- 提供接口：

  | 方法 | 路径 | 作用 |
  | --- | --- | --- |
  | GET | `/api/admin/overview` | 指标 + 汇总 |
  | GET | `/api/admin/rooms` | 房间列表 |
  | GET | `/api/admin/rooms/:code` | 房间详情（最近消息） |
  | DELETE | `/api/admin/rooms/:code` | 关闭房间并断开成员 |

- 生产环境请务必配合 HTTPS 使用（见 [DEPLOY.md](DEPLOY.md)）。
