# TrailMate Native（原生 iOS 12+ 出行 App）

为兼容 **iOS 12.x**（iPhone 5s/6 等老机）而重写的**纯原生** UIKit/Swift 版本——因为 iOS 12 的
WKWebView 缺少 `getUserMedia`、`BroadcastChannel` 等能力，网页/Capacitor 方案根本无法上 iOS 12。
本工程零第三方依赖，最低部署 **iOS 12.0**，向上兼容至最新 iOS（26.x）。

> 与仓库根目录的 Capacitor 网页版是两套并行实现：网页版做功能原型与新机体验，本原生版负责老机（iOS 12）。

## 当前进度（里程碑 1）
- ✅ 底部 Tab 骨架（跟车 / 记账 / 营地 / 变声）
- ✅ **跟车**：MapKit 地图（道路/卫星切换）+ CoreLocation 实时定位、一键回中
- ⏳ 记账 / 营地(蓝牙) / 变声：占位，后续里程碑逐个用原生实现
  - 记账/分摊：纯逻辑（原生易实现）；OCR 在 iOS 12 需内置 Tesseract（Vision 文字识别要 iOS 13+）
  - 营地蓝牙 Mesh：CoreBluetooth（iOS 12 可用），多跳 TTL 泛洪
  - 变声：AVAudioEngine + AVAudioUnitTimePitch（iOS 8+）

## 构建 / 运行
工程用 **XcodeGen** 描述（`project.yml`），避免手写 `.pbxproj`：

```bash
brew install xcodegen
cd ios12
xcodegen generate          # 生成 TrailMate.xcodeproj
open TrailMate.xcodeproj
```

Xcode 里：Target → Signing & Capabilities 选你的 Team（免费 Apple ID 即可）→ 选设备 → ⌘R。

### 装到 iOS 12.5.8 老机
新版 Xcode 自带的真机调试文件通常只覆盖较新 iOS；直连 iOS 12 设备调试可能需要补充对应的
DeviceSupport 文件。若 Xcode 提示 "Could not locate device support files"，把对应 iOS 12.x 的
DeviceSupport 目录放到 `Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/DeviceSupport/` 后重启 Xcode。

## CI
`.github/workflows/ios12-build.yml`：每次改动 `ios12/**` 自动用 XcodeGen 生成工程并编译（iOS 模拟器），
产出 `trailmate-ios12-sim` 供下载校验。真机安装请用本地 Xcode（CI 无签名证书）。
