# TrailMate 出游助手 🏕️

一款面向「朋友结伴出游」场景的 PWA（渐进式 Web 应用），用 React + Vite + TypeScript 构建，一次打开即可离线安装到手机主屏。包含五大功能：

| 模块 | 说明 |
| --- | --- |
| 👥 **群组** | 面对面创建 / 加入群组（6 位验证码 + 二维码扫描），设置昵称。**可保存多个群组，下次出游继续使用**。 |
| 🚗 **跟车** | Leaflet 地图（道路图 / 卫星图切换），显示自己与朋友的实时位置；按住「对讲机」按钮说话。 |
| 🏕️ **营地** | 无信号自组网群聊：文字 / 语音 / 视频互通，可叠加变声。 |
| 🧾 **记账** | AA 记账分摊：记录垫付人与分摊人、多种分摊方式，核算各家账单与最优转账方案；**拍照识别小票金额**。 |
| 🎭 **变声** | 趣味实时变声（汤姆猫 / 喜羊羊 / 小猪佩奇 / 孙悟空 / 猪八戒 …），可单独玩，也能在营地语音 / 视频中开启。 |

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

### 构建与运行
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

### 关于联网与「自组网」（已实现跨设备）
`src/lib/transport.ts` 定义统一的 `Transport` 接口，默认用 `CompositeTransport` 同时挂载两条链路，业务层（跟车/营地/对讲机）完全无感：

1. **`BroadcastTransport`**（`BroadcastChannel`）——同一设备多标签/多 PWA 实例互通，免服务器。
2. **`WebRTCTransport`**——**真正的跨设备 P2P 全网状连接**。位置、语音、聊天走设备之间的 WebRTC 直连，只需一个极小的信令服务器（`server/signaling.js`，约 60 行）帮忙牵线交换 SDP/ICE，业务数据不经过服务器。
   - 频道以群组的 **6 位验证码** 为房间 key，因此不同手机「输入同一验证码」即进入同一网状网。
   - 断线自动重连、ICE 候选缓冲、按 peerId 去重发起以避免 glare，均已处理。
   - 信令地址：开发环境默认 `ws://<当前主机>:8787`；生产环境用 `VITE_SIGNALING_URL` 配置（见 `.env.example`）。公网穿透如遇对称型 NAT，可在 `WebRTCTransport` 的 `iceServers` 里补一个 TURN。

> 已用两个独立浏览器实例（不共享 BroadcastChannel）实测：加入同一验证码后消息经 WebRTC 双向互通。

**演进为原生无信号 Mesh**：浏览器沙箱无法直接用蓝牙 Mesh / WiFi Direct。用
**Capacitor / React Native** 打包后，只需再写一个真实的 BLE / WiFi Direct 适配器加入
`CompositeTransport`，即可在完全无移动网络的营地实现自组网——上层代码零改动。

## 已知限制
- 无信号（连 WiFi 都没有）的真·蓝牙 Mesh 需原生适配器；Web 版跨设备走 WebRTC（需能互通的网络 + 信令服务器）。
- 地图瓦片、OCR 语言包首次加载需要网络（之后由 Service Worker 缓存离线可用）。
- 变声为风格化处理，非明星声音克隆。
