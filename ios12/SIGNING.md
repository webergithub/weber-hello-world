# 出「可直接安装的签名 IPA」

默认 CI 出的是**未签名** IPA（需 Sideloadly 重签）。若你有 Apple 开发者账号，配好下面的
Secrets 后，手动触发 **原生 iOS12 签名 IPA（手动）** 工作流即可产出**已签名、直接可装**的 IPA。

## 一、准备（在你的 Mac / Apple Developer 后台）
Bundle ID 为 **`cc.trailmate.app`**（如冲突，改 `ios12/project.yml` 里的 `PRODUCT_BUNDLE_IDENTIFIER` 并同步改描述文件）。

1. **证书**：钥匙串导出你的「Apple Development」或「Apple Distribution」证书为 `.p12`（含私钥），设一个导出密码。
2. **描述文件**：在 developer.apple.com 为 App ID `cc.trailmate.app` 创建对应的 Provisioning Profile（development 或 ad-hoc），下载 `.mobileprovision`，记下它的**名称**。
3. 记下你的 **Team ID**（10 位，developer 后台 Membership 里）。

把 p12 与 mobileprovision 转 base64：
```bash
base64 -i dist_cert.p12 | pbcopy         # → APPLE_CERT_P12_BASE64
base64 -i profile.mobileprovision | pbcopy  # → APPLE_PROVISION_PROFILE_BASE64
```

## 二、在仓库配置 Secrets
Settings → Secrets and variables → Actions → New repository secret：

| Secret | 值 |
|---|---|
| `APPLE_CERT_P12_BASE64` | 证书 .p12 的 base64 |
| `APPLE_CERT_PASSWORD` | .p12 导出密码 |
| `APPLE_PROVISION_PROFILE_BASE64` | 描述文件 .mobileprovision 的 base64 |
| `APPLE_PROVISION_PROFILE_NAME` | 描述文件名称 |
| `APPLE_TEAM_ID` | 10 位 Team ID |

## 三、出包
Actions → **原生 iOS12 签名 IPA（手动）** → Run workflow → 选 `method`（真机调试用 `development`；给别人装用 `ad-hoc`，需把设备 UDID 加进描述文件）→ Run。
完成后在该 run 的 Artifacts 下载 `trailmate-ios12-signed-ipa`，可直接安装到 iOS 12 设备。

> development/ad-hoc profile 需把目标 iOS 12 设备的 UDID 注册进去，否则装不上。
> 未配置 Secrets 时本工作流会失败（缺证书）——这是预期，配好再触发即可。
