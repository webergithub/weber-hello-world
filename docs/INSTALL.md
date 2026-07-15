# 装包上手 · 从 CI 产物到装进手机

两条轨道：**安卓装 APK**（最简单，几分钟）／**iPhone 装 IPA**（需一台电脑 + 免费 Apple ID 重签）。

---

## 第 0 步（共用）：从 GitHub Actions 下载安装包

1. 浏览器打开仓库 → 顶部 **Actions** 标签
2. 左侧选工作流：
   - 安卓 → **原生 Android App 构建 (TrailMate)**（`android-native-build`）
   - iPhone → **iOS 12 原生构建**（`ios12-build`）
3. 点最近一次**绿色 ✓ 成功**的运行
4. 拉到底部 **Artifacts**，下载：
   - `trailmate-android-apk` → 解压得到 `app-debug.apk`
   - `trailmate-ios12-unsigned-ipa` → 解压得到 `*.ipa`

> Artifacts 是 zip 压缩包，下载后先解压再用。90 天后过期，过期就重新触发一次构建。

---

## 轨道 A · 安卓装 APK

**A1. 传到手机**：数据线拷贝 / 微信"文件传输助手" / 网盘，把 `app-debug.apk` 弄到手机。

**A2. 允许未知来源**：点开 APK 时若提示"禁止安装未知应用"，按提示进
`设置 → 应用 → 特殊权限 → 安装未知应用`，给你用来打开它的那个 App（文件管理/浏览器/微信）打开"允许"。

**A3. 安装**：回到 APK，点"安装"→"完成"。

**A4. 首次打开授权**：进 App 后按引导允许**蓝牙 / 附近设备 / 定位 / 麦克风**（营地自组网、跟车定位、变声录音要用）。

✅ 完成。debug 签名不会过期，可长期用。

---

## 轨道 B · iPhone 装 IPA（Sideloadly，免费 Apple ID）

> 需要：一台 Windows 或 Mac 电脑、一根数据线、你的 Apple ID。免费签名 **7 天过期**，过期重签即可；一个免费 Apple ID 同时最多 3 个自签 App。

**B1. 装 Sideloadly**：电脑打开 [sideloadly.io](https://sideloadly.io) 下载安装。
Windows 另需装 **iTunes** 和 **iCloud**（用 Apple 官网的非 Microsoft Store 版本），Sideloadly 靠它们与设备通信。

**B2. 连接并信任**：数据线连 iPhone，手机弹"信任此电脑"点信任。

**B3. 载入 IPA**：打开 Sideloadly，把 `*.ipa` 拖进窗口（或点 IPA 选择框选它）。

**B4. 填 Apple ID**：在 Apple account 填你的 Apple ID 邮箱 → 点 **Start**，弹窗输入密码。
（若开了两步验证，需用 [appleid.apple.com](https://appleid.apple.com) 生成的 **App 专用密码**。）

**B5. 信任开发者证书**：装好后 App 图标出现但打不开是正常的。到 iPhone
`设置 → 通用 → VPN 与设备管理 → 开发者 App`，点你的 Apple ID → **信任**。

**B6. 打开 App**：回主屏点开，首次授权蓝牙/定位/麦克风。

✅ 完成。**7 天后**若打不开，用 Sideloadly 重复 B3–B5 重签一次即可。

### 备选：AltStore（免电脑手动重签）
装 **AltStore + AltServer**（电脑与手机同一 WiFi），可在证书快过期时**自动后台重签**，不用每 7 天手动来一次。步骤见 [altstore.io](https://altstore.io)。

---

## 常见问题

| 问题 | 处理 |
|---|---|
| 安卓装完打不开/闪退 | 确认是 `app-debug.apk`；老机型清一次后台重进；首次要授蓝牙/定位权限 |
| Sideloadly 卡在 "Requesting..." | 检查 iTunes/iCloud 已装且能识别设备；换数据线/USB 口；重连信任 |
| iPhone 提示"无法验证 App" | 没做 B5 信任证书；或证书已过期（重签） |
| 提示 Apple ID 密码错误 | 开了两步验证要用 App 专用密码，不是登录密码 |
| 想装到 iOS 12 老机 | 本 App 部署目标就是 iOS 12.0，正常可装；Sideloadly 同样支持老系统 |

装完两台后，照 `docs/REAL-DEVICE-TEST.md` 的清单做蓝牙互通实测。
