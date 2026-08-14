# 打包 iOS / Android 应用 · Native app packaging

LinkTalk 用 **Capacitor** 打包成原生 app：iOS 和 Android 共用同一套界面代码，
原生能力（NFC、相机扫码、系统分享）通过 Capacitor 插件桥接。

LinkTalk ships as native apps via **Capacitor**: one shared UI codebase for both
platforms, with NFC / camera / share coming from native plugins.

> **必须在你自己的机器或 CI 上构建。** iOS 必须 macOS + Xcode（Apple 的硬性要求），
> Android 需要 Android SDK。本仓库提供全部配置与脚本，但二进制包不能在没有这些
> 工具链的环境里产出。
>
> **Binaries must be built on your machine or CI.** iOS requires macOS + Xcode
> (Apple's rule, no way around it); Android requires the Android SDK. Everything
> else — config, scripts, app logic — is in this repo.

---

## 1. 先部署服务端 (deploy the server first)

原生 app 从你部署的服务器加载界面，因此**先按 [DEPLOY.md](DEPLOY.md) 把服务端跑起来**
（必须 HTTPS：麦克风、分享、NFC 都要求安全上下文）。

这样做的好处：服务端一发版，两个平台的 app 界面同步更新，无需重新过审。

## 2. 生成原生工程 (scaffold the native projects)

```bash
npm install

# 指向你的服务器，并生成 Android 工程
LINKTALK_SERVER_URL=https://talk.example.com npm run mobile:add:android

# 生成 iOS 工程（需在 macOS 上执行）
LINKTALK_SERVER_URL=https://talk.example.com npm run mobile:add:ios
```

之后每次改动同步：

```bash
npm run mobile:sync
npm run mobile:open:android   # 打开 Android Studio
npm run mobile:open:ios       # 打开 Xcode
```

在 Android Studio / Xcode 里选择签名与目标设备即可构建 APK / IPA。

## 3. 装原生插件 (native plugins)

界面通过 `window.LinkTalkNative.*` 调用原生能力；没有插件时会自动退回
Web 方案（Web NFC / BarcodeDetector / 系统分享），所以插件是**增强**而非必需。

```bash
# 扫码（iOS + Android 都支持，比 BarcodeDetector 可靠）
npm i @capacitor-mlkit/barcode-scanning

# NFC（Android 碰一碰）
npm i @capawesome-team/capacitor-nfc

npm run mobile:sync
```

然后在原生工程里把插件接到桥上（`window.LinkTalkNative = { scan, nfc, proximity }`），
接口约定见 `public/js/platform.js` 与 `public/js/scan.js`。

### 权限声明（已自动化）

`npm run mobile:add:*` 与 `mobile:sync` 会自动执行 `scripts/patch-native.mjs`，
把下列声明写进原生工程（幂等，可重复执行）：

| 平台 | 自动写入 |
| --- | --- |
| Android `AndroidManifest.xml` | `RECORD_AUDIO`（语音）、`CAMERA`（扫码）、`NFC`（碰一碰），并把 NFC 声明为**可选硬件**，避免 Play 商店过滤掉无 NFC 的机型 |
| iOS `Info.plist` | `NSMicrophoneUsageDescription`、`NSCameraUsageDescription`、`NSLocalNetworkUsageDescription`、`NSBonjourServices`（`_linktalk._tcp/_udp`） |

> `ios/` 与 `android/` 是**生成物**，已加入 `.gitignore`。一条命令即可重建并自动补齐权限，
> 因此不必把上百个脚手架文件提交进仓库。

---

## 三种加入方式对应的实现 (how each join method works)

| 场景 | 方式 | 实现 |
| --- | --- | --- |
| **同为 Android** | 碰一碰 | NFC：一台写入邀请链接，另一台碰上去读取。原生用 NFC 插件，Chrome 上用 Web NFC |
| **同为 iPhone** | 碰一碰 | 系统分享面板里的 **AirDrop**（现成可用，一步到位）。若要真正的「靠近即连」，需要自写 MultipeerConnectivity 插件并接到 `LinkTalkNative.proximity`——iOS 不开放 iPhone 间 NFC，这是唯一路径 |
| **iPhone ↔ Android** | **4 位面对面数字** | 房主界面显示 4 位数字，对方直接输入即可加入。**不需要相机、不需要 NFC、跨平台通用** |
| **iPhone ↔ Android** | 扫二维码 | 原生用 ML Kit 扫码插件；Chrome 上用 BarcodeDetector；也可直接用系统相机扫 |

### 为什么用 4 位数字？

6 位房间码适合二维码和链接，但当面念给对方听很别扭。4 位数字好念、好输入，
代价是空间只有 1 万个，所以安全性来自**稀缺 + 短时效**而非码本身：

- 有效期默认 **5 分钟**（`PIN_TTL_MS`），到期自动回收；
- 同一时刻线上的码极少，猜测大概率落空；
- `/api/pair/:pin` 单 IP **每分钟 20 次**限流（`RATE_PAIR_PER_MIN`），暴力破解会先耗尽预算；
- 房间关闭立即回收该房间的所有码；
- 指标里 `pins.missed` 激增即是撞库特征，可在 `/admin` 观察。

这与 AirDrop 一类当面配对码的取舍一致：**适合面对面，不能替代邀请链接**。

---

## 上架前检查 (store checklist)

1. 在 `capacitor.config.json` 改 `appId`（如 `com.yourcompany.linktalk`）与 `appName`。
2. 换应用图标与启动图（`public/icon.svg` 是网页版图标，原生图标在各自工程里）。
3. iOS：App Store Connect 建 App、配置签名；Android：生成 keystore 并配置 `signingConfigs`。
4. 隐私说明：本 app 会把语音上传到你配置的 Whisper 服务、把文本发到翻译服务——
   两者都要在隐私政策里写明（App Store 与 Google Play 均会核查）。
5. 确认服务端 `ADMIN_TOKEN` 已设置且 `/admin` 不对公网开放（见 [BACKEND.md](BACKEND.md)）。
