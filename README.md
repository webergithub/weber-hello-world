# TrailMate 出游助手 🏕️

一款面向「朋友结伴出游」场景的 PWA（渐进式 Web 应用），用 React + Vite + TypeScript 构建，一次打开即可离线安装到手机主屏。包含五大功能：

| 模块 | 说明 |
| --- | --- |
| 👥 **群组** | 面对面创建 / 加入群组（6 位验证码 + 二维码扫描），设置昵称。**可保存多个群组，下次出游继续使用**。 |
| 🚗 **跟车** | Leaflet 地图（道路图 / 卫星图切换），显示自己与朋友的实时位置；按住「对讲机」说话，**对讲支持变声扩展选项**。 |
| 🏕️ **营地** | 无信号自组网群聊：文字 / 语音 / 视频互通，可叠加变声。 |
| 🧾 **记账** | AA 记账分摊：记录垫付人与分摊人、多种分摊方式，核算各家账单与最优转账方案；**拍照识别小票金额**。 |
| 🎭 **变声** | 趣味实时变声（汤姆猫 / 喜羊羊 / 小猪佩奇 / 孙悟空 / 猪八戒 …），可单独玩，也能在营地语音 / 视频、以及跟车对讲机中开启。 |
| 📹 **监控** | 远程查看端：多路实况、人物事件时间轴、**一日剪影**回放、推送订阅。后端见 [`watchtower/`](watchtower/)。 |

> 📱 **不区分机型互联**：iPhone、安卓手机、网页端使用**同一套协议**互通——群组走同一验证码房间，蓝牙 Mesh 用**相同的 Service/Characteristic UUID 与分片协议**，WebRTC 用平台无关的随机标识。因此 iOS 与 Android 混合队伍可直接互相连接、互发位置/语音/消息。跟车页顶部会实时显示同行设备机型分布（如「iPhone×2 · 安卓×1」）。

## 测试与安装文档

| 文档 | 用途 |
| --- | --- |
| [`docs/INSTALL.md`](docs/INSTALL.md) | 装包上手：从 GitHub Actions 下载安装包 → 安卓 APK 侧载 / iPhone 用 Sideloadly 免费重签 |
| [`docs/REAL-DEVICE-TEST.md`](docs/REAL-DEVICE-TEST.md) | 两台真机蓝牙互通实测清单（扫码进队 / 营地互聊 / 跟车互见 / 离线记账 / 变声，含排障） |

原生 App 源码见 [`ios12/`](ios12/)（iOS 12+ 纯原生）与 [`android-native/`](android-native/)（Kotlin 原生），二者共用同一蓝牙 Mesh 线协议，可跨平台互通。

## 快速开始

```bash
npm install
npm run dev:all  # 同时启动 Web + 信令服务器（推荐：跨设备真联通）
# 或分开跑：
npm run dev      # 仅前端（同设备多标签演示）
npm run server   # 仅信令服务器（默认 :8787）
npm run build    # 生产构建
npm run preview  # 预览生产包
```

- 局域网真机测试：`npm run dev:all` 后，多部手机连同一 WiFi，浏览器打开电脑的 `http://<电脑IP>:5173`，进同一群组即可通过 **WebRTC P2P** 互通。
- 摄像头、定位、麦克风等能力需要 **HTTPS 或 localhost** 才能授权。跨机测试建议部署到 https 站点，或用本机 https 代理。

## 📱 原生 App（iOS / Android）

本项目已用 **Capacitor** 封装为真正的 iOS / Android 原生 App —— 同一套 React 代码跑在原生
WebView 里，并通过原生插件访问 GPS、摄像头、麦克风、蓝牙等能力。原生工程已生成并纳入版本库：

```
android/   Android Studio 工程（Gradle）
ios/       Xcode 工程（Swift Package Manager，无需 CocoaPods）
capacitor.config.ts
```

### 已接入的原生能力
| 能力 | 插件 / 实现 | 用途 |
| --- | --- | --- |
| GPS 定位 | `@capacitor/geolocation`（`src/lib/geo.ts` 自动在原生/Web 间切换） | 跟车实时位置，支持后台 |
| 摄像头 / 麦克风 | WebView `getUserMedia` + 原生权限 | 拍照小票、语音/视频、变声、对讲机 |
| 网络状态 | `@capacitor/network` | 链路判断 |
| 状态栏 / 键盘 | `@capacitor/status-bar` `@capacitor/keyboard` | 原生外观 |
| 蓝牙 / 局域网 | 权限已在 Manifest / Info.plist 声明 | 预留给营地无信号 Mesh 适配器 |

权限文案已配置：Android 见 `android/app/src/main/AndroidManifest.xml`，iOS 见 `ios/App/App/Info.plist`。

### 云端自动出包（GitHub Actions，无需本地 IDE）
仓库内置 `.github/workflows/build-mobile.yml`，每次 push 或手动触发即自动编译：
- **Android**：`app-debug-apk` —— **直接安装到安卓真机**，蓝牙 Mesh 可用。
- **iOS**：`app-ios-simulator-build` —— iOS 模拟器编译产物，用于**校验原生 Swift 代码**（含蓝牙插件）能否编译通过。
- 产物在对应 Actions run 的 **Artifacts** 里下载。

> **iOS 真机安装**：CI 环境无 Apple 签名证书、也未预装 iOS 设备平台，故 CI 只做「模拟器编译校验」。要装到 iPhone 真机（含测试蓝牙 Mesh），在本机 `npm run ios` 打开 Xcode，选好签名团队后直接 Run 即可（Xcode 会用你的 Apple ID 自动签名）。如需 CI 直接产出签名 IPA，可在仓库 Secrets 配置 Apple 证书与描述文件后改用 device 归档。

### 本地构建与运行
> 需要在 **本机**（能访问 Google Maven / Android SDK 的网络）操作，并安装对应 IDE。

```bash
npm install
npm run build          # 产出 dist/
npx cap sync           # 同步 Web 资源与插件到原生工程

# Android（需 Android Studio + SDK，compileSdk 36）
npm run android        # = build + cap sync android + 打开 Android Studio
#  或命令行直接打包： cd android && ./gradlew assembleDebug
#  产物： android/app/build/outputs/apk/debug/app-debug.apk

# iOS（需 macOS + Xcode）
npm run ios            # = build + cap sync ios + 打开 Xcode
#  在 Xcode 里选择签名团队后 Run 到真机 / 模拟器
```

真机热重载调试：把 `capacitor.config.ts` 里的 `server.url` 注释打开、填电脑局域网 IP，
配合 `npm run dev:all`，即可边改边看。

> 说明：本仓库的 `android/` `ios/` 已由 `npx cap add` 官方模板生成并通过 `npx cap sync`
> 校验；由于本次开发环境的出网策略屏蔽了 Google 域名（Android SDK / Google Maven 不可达），
> 未在此环境内编译出 APK/IPA——在你本机执行上面命令即可一键打包。

## 各模块细节

### 👥 群组（多群组持久化）
- 创建群组自动生成 6 位加入验证码与二维码，可展示给朋友「面对面」扫码加入。
- 所有群组、成员、账目保存在本机 `localStorage`，重启 App 后仍在，**支持保存并管理多个群组**。
- 群组管理内可重命名群组 / 自己的昵称、添加线下同行成员、删除群组。

### 🚗 跟车地图 + 对讲机
- 地图基于成熟框架 **Leaflet / react-leaflet**：
  - 道路图：OpenStreetMap 瓦片
  - 卫星图：Esri World Imagery 瓦片（右上角一键切换）
- 通过浏览器 `geolocation.watchPosition` 获取并广播自己的位置，地图上以彩色圆点标识自己与每位朋友。
- 底部「按住说话」对讲机：按下录音、松开把语音片段广播给同群成员，收到即自动播放。
- **对讲机变声扩展**：对讲按钮上方有「🎭 变声」选项，选中角色（汤姆猫 / 孙悟空 / 猪八戒 …）后按住说话，声音会先经 Web Audio 实时变声再广播，收听方直接听到卡通声。默认原声。
- **不区分机型**：位置广播携带设备平台标识，地图标记与顶部信息条会显示同行者机型（iPhone / 安卓 / 网页），iOS 与安卓可混合组队。

### 🏕️ 营地自组网通信
- 进入前有「授权并开启自组网」引导页，说明按 **蓝牙 → WiFi 直连 → 移动网络** 的优先级组网。
- 群聊支持文字、语音、视频三种消息；语音 / 视频可选择变声角色后再发送。

### 🧾 记账分摊 + 小票 OCR
- 记一笔：项目、金额、垫付人、分类、分摊参与人。
- 三种分摊方式：**平均 / 按份数 / 按精确金额**（金额以「分」为单位整数计算，杜绝浮点误差，余数自动分配）。
- 结算页给出「各家账单」（应收 / 应付）与 **最少笔数的最优转账方案**。
- **拍照录入小票**：调用手机摄像头拍照 → 本机 **Tesseract.js** OCR 识别 → 自动提取总金额与商户名并回填。识别在本机完成，图片不外传。

### 🎭 趣味变声
- 基于 **Web Audio API** 实时处理：音高偏移（业界公开的 "Jungle" 双延时线交叉淡化算法）+ 共振峰滤波 + 失真 / 回声 / 颤音，组合出多种卡通角色风格。
- 支持实时试听（建议戴耳机）与录制下载。
- > 说明：浏览器端做的是「风格化变声」，并非 AI 明星声音克隆（后者需服务端语音模型）。

## 技术架构

```
server/
└─ signaling.js         # 极简 WebRTC 信令服务器（房间转发 SDP/ICE，数据走 P2P）
src/
├─ store.tsx            # 全局状态（多群组 + 账目），localStorage 持久化
├─ types.ts             # 领域模型
├─ lib/
│  ├─ transport.ts      # 可插拔对等传输层（Broadcast + WebRTC 组合；原生 BLE/WiFi 可再加）
│  ├─ useChannel.ts     # 订阅群组频道的 Hook
│  ├─ settle.ts         # AA 净额计算 + 最小转账算法
│  ├─ voicefx.ts        # 实时变声引擎（Jungle 音高偏移 + 效果链）
│  ├─ joinlink.ts       # 二维码/验证码编解码
│  └─ id.ts / storage.ts
└─ features/
   ├─ groups/           # 群组创建/加入/管理
   ├─ convoy/           # 跟车地图 + 对讲机
   ├─ camp/             # 营地群聊（文字/语音/视频 + 变声）
   ├─ ledger/           # 记账分摊 + 小票 OCR
   └─ voice/            # 独立变声 App
```

### 🔵 真实蓝牙自组网（BLE Mesh，原生）
在完全没有移动网络、也没有 WiFi 的营地，用**手机自带的蓝牙**让大家互联互通。已实现为一个
自定义 Capacitor 原生插件 `BleMesh`：每台手机**同时**扮演两个 BLE 角色 —— 外围(广播 +
GATT 服务) 与 中心(扫描 + 连接)，因此蓝牙范围内的任意两台手机都能直接互发消息，无需任何服务器。

- 原生实现：Android `android/app/src/main/java/com/trailmate/app/BleMeshPlugin.java`（`BluetoothLeAdvertiser` + `BluetoothGattServer` + `BluetoothLeScanner` + `BluetoothGatt`）；iOS `ios/App/App/BleMeshPlugin.swift`（`CBPeripheralManager` + `CBCentralManager`）。两端使用**相同的 Service/Characteristic UUID 与分片协议**，iOS 与 Android 互通。
- JS 侧 `src/lib/bleTransport.ts` 把它接入统一的 `Transport`，与 BroadcastChannel、WebRTC 组成 `CompositeTransport`：**有蓝牙走蓝牙，没蓝牙自动用网络**，业务层无感。链路优先级按需求实现为 **蓝牙 > WiFi直连 > 移动网络**，营地页顶部实时显示当前链路与邻居数。
- 消息按群组验证码分房间（JS 层过滤）；蓝牙带宽有限，文字/位置直接走蓝牙，语音/视频等大消息自动改走网络链路。
- 权限已配置好：Android 见 `AndroidManifest.xml`（`BLUETOOTH_SCAN/ADVERTISE/CONNECT`、旧系统定位）；iOS 见 `Info.plist`（`NSBluetoothAlwaysUsageDescription` 等）。插件已在 `MainActivity`（Android）与 Xcode 工程（iOS，`CAPBridgedPlugin` 自动注册，已写入 `project.pbxproj`）中登记，`npx cap sync` 后即随 App 编译。
- 使用：进「营地」点「授权并开启自组网」即触发真实蓝牙初始化；两台真机进同一验证码群组即可蓝牙互聊。**需在真机上测试**（模拟器无蓝牙硬件）。
- **多跳中继（Flooding Mesh）**：每条消息带 8 字节全局 msgId + TTL（默认 4 跳）。节点收到未见过的消息会**去重后转发给其它邻居**，因此不在你蓝牙直连范围、但在「朋友的朋友」范围内的同伴也能收到——覆盖范围随人数自然扩大。msgId 去重（保留 30s）避免转发风暴，源头自标记己见避免回环。

### 关于联网与「自组网」（已实现跨设备）
`src/lib/transport.ts` 定义统一的 `Transport` 接口，默认用 `CompositeTransport` 同时挂载两条链路，业务层（跟车/营地/对讲机）完全无感：

1. **`BroadcastTransport`**（`BroadcastChannel`）——同一设备多标签/多 PWA 实例互通，免服务器。
2. **`WebRTCTransport`**——**真正的跨设备 P2P 全网状连接**。位置、语音、聊天走设备之间的 WebRTC 直连，只需一个极小的信令服务器（`server/signaling.js`，约 60 行）帮忙牵线交换 SDP/ICE，业务数据不经过服务器。
   - 频道以群组的 **6 位验证码** 为房间 key，因此不同手机「输入同一验证码」即进入同一网状网。
   - 断线自动重连、ICE 候选缓冲、按 peerId 去重发起以避免 glare，均已处理。
   - 信令地址：开发环境默认 `ws://<当前主机>:8787`；生产环境用 `VITE_SIGNALING_URL` 配置（见 `.env.example`）。公网穿透如遇对称型 NAT，可在 `WebRTCTransport` 的 `iceServers` 里补一个 TURN。

> 已用两个独立浏览器实例（不共享 BroadcastChannel）实测：加入同一验证码后消息经 WebRTC 双向互通。

**原生无信号 Mesh 已实现**：见上文「真实蓝牙自组网」。`CompositeTransport` 在原生 App 里
自动加入 `BleTransport`，与 WebRTC / BroadcastChannel 组合，上层代码零改动。

## 已知限制
- 蓝牙 Mesh 需真机测试（模拟器无蓝牙硬件）；多跳中继为 TTL 泛洪(默认 4 跳)。
- Web 版跨设备走 WebRTC（需能互通的网络 + 信令服务器）；蓝牙自组网仅原生 App 可用。
- 地图瓦片、OCR 语言包首次加载需要网络（之后由 Service Worker 缓存离线可用）。
- 变声为风格化处理，非明星声音克隆。
