# Watchtower 哨塔 📹

**把米家、360、萤石、乐橙、涂鸦、海康/大华等各家摄像头汇到一处；服务端自动做人物分析，
每天生成一条「一日剪影」，推送到手机上看。**

先说清楚一个前提：**没有任何一个 SDK 能通吃所有平台。** 市面上宣称"全平台接入"的产品，
内部都是「分平台适配 → 统一归一化 → 上层只面对归一化后的流」。本项目就是按这个结论做的，
完整调研见 [`docs/01-平台接入调研.md`](docs/01-平台接入调研.md)。

## 支持的接入方式

| 平台 | 怎么接 | 状态 |
| --- | --- | --- |
| **小米 / 米家** | go2rtc 内置 `xiaomi://` P2P，或 Micam 桥接成本地 RTSP | ✅ 无官方云 API，走本地桥接 |
| **360 智能摄像机** | 手工地址 / 端侧 SDK 转推 | ⚠️ 最封闭的一家，不能服务端直接拉流 |
| **萤石 EZVIZ（海康民用）** | 官方 OpenAPI，token + 带时效播放地址 | ✅ 国内最省事 |
| **乐橙 Imou（大华民用）** | 官方 OpenAPI，MD5 签名 + 直播通道 | ✅ 通道用完会自动释放配额 |
| **涂鸦 Tuya** | 官方 OpenAPI，HMAC-SHA256 签名 | ✅ 覆盖大量贴牌 IPC |
| **海康 / 大华 / 宇视 / TP-Link VIGI** | ONVIF 自动发现 + RTSP | ✅ 含标准库实现的 WS-Discovery |
| **Tapo / Ring / Nest / Wyze / HomeKit** | 透传给 go2rtc 的内置协议 | ✅ |
| **已有 NVR / Frigate / Home Assistant** | 直接当上游 RTSP，或 `hass://` | ✅ |

新增一个平台 = 写一个实现 `resolve()` 的类并注册，**上层一行不用改**。

## 它做什么

```
各平台适配 → go2rtc 归一化 → ┬ 直播（WebRTC/fMP4/HLS，App 里点开就看）
                             ├ 分析（抽帧 → 人形检测 → 跟踪 → 事件）
                             ├ 录制（10 秒分段，事件带前摇裁片）
                             └ 每日 23:30 → 一日剪影（选段 + 合成 + 中文文案）→ 推送
```

- **人物分析**：可插拔四档检测器（YOLO / ONNX / OpenCV 运动 / 无依赖桩），
  按可用性自动降级；轨迹会翻译成「由左向右」「走近」「驻留」这类人话。
- **一日剪影**：按重要度选段，带摄像头配额与时间去重（不让一路门口摄像头吃掉整个剪影），
  烧入「时间 + 位置 + 人数」字幕，生成封面与中文摘要。
- **推送**：分数门槛 + 同摄像头聚合窗口 + 免打扰时段，三道闸门治"推太多没人看"。
- **查看端**：直接做在本仓库的 Capacitor App 里（「监控」页），iOS / Android / 网页同一套。

## 快速开始

```bash
cd watchtower/deploy
cp watchtower.example.json watchtower.json     # 改 api_token
export WATCHTOWER_API_TOKEN='换成足够长的随机串'
docker compose up -d

docker compose exec watchtower python -m watchtower discover      # 扫局域网
docker compose exec watchtower python -m watchtower add-camera \
  --name 前院 --platform generic -o url='rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/101'
```

然后在 App 的「监控 → 设置」里填服务端地址与令牌即可。详见
[`docs/03-部署与运维.md`](docs/03-部署与运维.md)。

## 目录

```
watchtower/
├── docs/
│   ├── 01-平台接入调研.md      各平台能不能拿到流、怎么拿（含来源）
│   ├── 02-架构与数据流.md      分层职责与六个关键决策
│   ├── 03-部署与运维.md        部署、加摄像头、选型、排障
│   └── 04-合规与隐私.md        2025 年两部新规与代码里的隐私默认值
├── deploy/                     Dockerfile / compose / go2rtc 引导配置
└── server/
    ├── watchtower/
    │   ├── adapters/           各平台 → 一条可播 URL
    │   ├── media/              go2rtc 归一化、ffmpeg 录制与剪辑
    │   ├── analysis/           检测 / 跟踪 / 事件聚合 / 人脸打码
    │   ├── digest/             选段 / 合成 / 文案
    │   ├── push/               通道与打扰控制
    │   └── api/                REST + SSE
    └── tests/                  73 个用例，不联网、不依赖 ffmpeg
```

## 依赖是分级的

核心逻辑（适配器、事件聚合、剪影选段、推送策略）**只用 Python 标准库**，
`requirements.txt` 里的三个包只服务于 HTTP 接口本身。AI 能力全部可选，
一个都不装也能跑通「接流 → 直播 → 录制 → 剪影（九宫格封面）→ 推送」的完整链路。

| 想要什么 | 装什么 |
| --- | --- |
| 接流 / 直播 / API | `requirements.txt` |
| 录制 / 剪影成片 | 系统装 `ffmpeg` |
| 运动检测 / 人脸打码 | `opencv-python-headless` |
| 人形检测 | `onnxruntime + pillow`（推荐）或 `ultralytics` |
| 剪影自然语言解说 | `anthropic` + `ANTHROPIC_API_KEY` |

## ⚠️ 部署前请读合规文档

《公共安全视频图像信息系统管理条例》（2025-04-01）与
《人脸识别技术应用安全管理办法》（2025-06-01）对录像保留、人脸信息处理、安装位置
都有硬性要求。本项目的默认值已经按这两部法规设置（人脸识别默认关闭、缩略图默认打码、
保留 30 天），但**装在哪里、有没有取得同意，是部署方的责任**。
详见 [`docs/04-合规与隐私.md`](docs/04-合规与隐私.md)。

仅面向自有场所、自有设备。接入他人平台账号需取得授权。
