# 十岁啦 · iPad 应用

一个很薄的原生外壳：全屏、横屏、不熄屏，里面装的就是 `birthday/` 这套网页。iPad 的前置摄像头可以用来做互动。

## 两种用法

| | 怎么设置 | 照片在哪 |
| --- | --- | --- |
| 连接你的相册服务器 | 在 `project.yml` 里把 `TenUpServerURL` 改成你的 https 网址 | 服务器上，各设备同步 |
| 单机 | `TenUpServerURL` 留空 | 这台 iPad 上 |

连接服务器时如果连不上，会自动打开随应用打包的那份网页。

## 构建

推送到 `claude/**` 或 `master` 分支后，GitHub Actions（"十岁啦 iPad 应用构建"）会自动编译并产出**未签名的 IPA**，在该次运行的 Artifacts 里下载。

在自己的 Mac 上：

```bash
cd birthday/ipad
```

```bash
sh prepare-web.sh
```

```bash
brew install xcodegen && xcodegen generate && open TenUp.xcodeproj
```

## 安装到 iPad

未签名的 IPA 不能直接安装，需要苹果的签名，两条路：

- **有 Apple 开发者账号**：在 Xcode 里选好 Team，直接运行到 iPad，或归档后走 TestFlight。
- **没有**：用 Sideloadly / AltStore 以自己的 Apple ID 重签后安装，免费账号每 7 天要重签一次。仓库里 `ios12/SIGNING.md` 写的流程同样适用。

## 已知情况

- 这份工程是在没有 Mac 的环境里写的，靠自动构建验证能否编译；**没有在真机上运行过**。
- 单机用法下页面是从应用包里以本地文件方式打开的。摄像头互动在这种方式下能否使用取决于系统版本，**需要真机确认**；连接服务器（https）的用法是摄像头最有把握的方式。
- 摄像头权限只授予相册自己的页面，且只授予摄像头，不含麦克风。
