# TrailMate Native（原生 Android 出行 App）

与 `ios12/`（原生 iOS）对应的**原生 Android** 版本，纯 Kotlin，覆盖老安卓机（minSdk 21 / Android 5.0），
与仓库根目录的 Capacitor `android/`（网页壳）是两套并行实现。

## 当前进度
- ✅ **记账**：成员管理、记一笔（平均分摊）、各家净额、最优转账结算，SharedPreferences 持久化
- ✅ **跟车**：osmdroid 地图（道路/卫星切换）+ 定位（底部导航切换）
- ⏳ 营地（蓝牙 Mesh，Kotlin）、变声、队伍二维码 —— 后续里程碑逐个补

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
