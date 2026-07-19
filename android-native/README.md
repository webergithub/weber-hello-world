# TrailMate Native（原生 Android 出行 App）

与 `ios12/`（原生 iOS）对应的**原生 Android** 版本，纯 Kotlin，覆盖老安卓机（minSdk 21 / Android 5.0），
与仓库根目录的 Capacitor `android/`（网页壳）是两套并行实现。

## 当前进度
- ✅ **记账**：成员管理、记一笔（平均分摊）、各家净额、最优转账结算，SharedPreferences 持久化
- ✅ **跟车**：osmdroid 地图（道路/卫星切换）+ 定位 + **蓝牙 Mesh 离线位置共享**（地图上互见同伴，含 iOS 同伴）
- ✅ **营地**：蓝牙 Mesh 多跳群聊（无网互通），支持改昵称 / 输入队伍码分房间
- ✅ **变声**：录音 → 变速重采样 + 环形调制，9 角色与 iOS 对齐（汤姆猫/佩奇/喜羊羊/悟空/八戒/花栗鼠/机器人/大魔王/原声）
- ✅ **队伍二维码**：显示/新建 6 位队伍码 + 二维码，扫码入队（zxing），与 iOS `TM:CODE` 约定互扫互通
- ✅ **短语音**：营地按住 🎤 录 ≤10s，AAC over BLE 端到端加密广播，点按播放（跨 iOS 互通）
- ✅ **小票 OCR**：记一笔可选小票照片，ML Kit 离线识别自动填金额
- ✅ **健壮性**：蓝牙关闭/无邻居实时告警；同伴标记 15s 变淡 60s 移除；账本导出/导入备份

## 跨平台互通（Android ↔ iOS）
`BleMesh.kt` 与 iOS 原生版 `BleMesh.swift` 使用**相同的 Service/Characteristic UUID 与帧协议**
（13 字节帧头：8 msgId + 1 ttl + 2 seq + 2 total，多跳 TTL 泛洪 + msgId 去重），
`MeshBus` 封装（[kind][teamLen][team][payload]）与聊天/位置 JSON 键也一致——
**安卓机与 iPhone（iOS 12+）进同一队伍码即可蓝牙互聊、地图互见**，无需任何网络。
默认都在「公共队」，开箱即通；营地页「队伍」可输入同伴的队伍码进私有队。

## 构建
CI 自动出 APK：`.github/workflows/android-native-build.yml`（改动 `android-native/**` 即触发），
产物 `trailmate-android-apk` 可**直接安装**到安卓机（debug 签名）。

本地：用 Android Studio 打开 `android-native/`（会自动补 Gradle wrapper），或命令行：
```bash
cd android-native
gradle wrapper --gradle-version 8.9   # 首次生成 wrapper
./gradlew assembleDebug
# 产物 app/build/outputs/apk/debug/app-debug.apk
```
安装：`adb install -r app/build/outputs/apk/debug/app-debug.apk`，或把 APK 传到手机允许「未知来源」安装。

## 技术
- Kotlin + AndroidX + Material3，AGP 8.5.2 / Gradle 8.9 / JDK 17，compileSdk 34
- 记账逻辑 `Ledger.kt` 与 iOS `LedgerModel.swift` 算法一致（分为单位整数、最小转账贪心）
