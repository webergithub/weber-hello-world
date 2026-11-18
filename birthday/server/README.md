# 十岁啦 · 相册服务端

一个纯 Node.js 的小服务（18 以上，不依赖任何 npm 包）。它负责登录与短信验证、可信设备与国家判断、相册读写与多终端同步，并把照片和音频加密后存盘。它同时把 `birthday/` 这套网页提供给浏览器，未登录时只能看到登录页。

设计说明见 `../docs/tenup-requirements-design.html` 的第 7、8、10 节。

## 启动

```bash
cd birthday
```

```bash
node server/server.js
```

第一次启动会：

- 在 `server/master.key` 生成服务器主密钥。**请另外保存一份，并且不要和数据文件夹放在一起。**
- 在日志里打印一行"设置口令 Setup token"。打开网站做首次设置时要填它。

服务只监听本机 `127.0.0.1:8787`。对外要放在带 HTTPS 证书的反向代理后面（摄像头和登录都要求 HTTPS）。Nginx 的最小配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 510m;      # 要比 TENUP_MAX_VIDEO_MB 稍大，否则大视频会被 Nginx 挡掉
    proxy_request_buffering off;    # 视频边收边加密，不先落到 Nginx 的临时文件
    client_body_timeout 300s;       # 手机网络时快时慢，传大视频时别因为一时停顿就断开
    proxy_send_timeout 300s;
}
```

用了反向代理就要设 `TENUP_TRUST_PROXY=1`，否则服务看到的来源地址永远是 127.0.0.1。

## 配置（环境变量）

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `TENUP_PORT` / `TENUP_HOST` | 监听端口和地址 | `8787` / `127.0.0.1` |
| `TENUP_DATA` | 数据文件夹（里面全是密文） | `server/data` |
| `TENUP_MASTER_KEY` | 服务器主密钥，64 位十六进制 | 不设则用下面的文件 |
| `TENUP_MASTER_KEY_FILE` | 主密钥文件 | `server/master.key` |
| `TENUP_TRUST_PROXY` | 设为 `1`：信任反向代理传来的来源地址和协议 | 关 |
| `TENUP_SESSION_DAYS` | 登录状态保持天数；`0` 表示关掉浏览器就要重新输密码 | `30` |
| `TENUP_SMS` | 短信通道：`console`、`aliyun`、`tencent`、`webhook` | `console` |
| `TENUP_GEOIP` | IP 归属地库文件（`.mmdb`），用来判断国家 | 不设则不做国家判断 |
| `TENUP_COUNTRY_HEADER` | 反向代理已经算好国家时，读取的请求头名，例如 `cf-ipcountry` | 无 |
| `TENUP_SETUP_TOKEN` | 自己指定首次设置口令 | 随机生成并打印 |
| `TENUP_MAX_VIDEO_MB` | 一段视频最大多少 MB（改大时 Nginx 的 `client_max_body_size` 也要跟着改大） | `500` |
| `TENUP_UPLOAD_MINUTES` | 一次上传最多用多少分钟（500 MB 在 10 Mbps 上行下约 7 分钟） | `60` |

### 短信

- `console`：验证码打印在服务日志里。只用于调试，上线前必须换掉。
- `aliyun`：`TENUP_ALIYUN_KEY_ID`、`TENUP_ALIYUN_KEY_SECRET`、`TENUP_ALIYUN_SIGN`（签名）、`TENUP_ALIYUN_TEMPLATE`（模板，变量名为 `code`）。
- `tencent`：`TENUP_TENCENT_SECRET_ID`、`TENUP_TENCENT_SECRET_KEY`、`TENUP_TENCENT_APP_ID`、`TENUP_TENCENT_SIGN`、`TENUP_TENCENT_TEMPLATE`。
- `webhook`：把 `{ phone, code, purpose }` POST 到 `TENUP_SMS_WEBHOOK`，可带 `TENUP_SMS_WEBHOOK_TOKEN`。

阿里云和腾讯云两种接法是按官方签名方法写的，**没有用真实账号发过短信**，上线前请各发一条确认。

### 国家判断

需要一份 MaxMind 格式的国家库。DB-IP Lite（署名许可，免费）可以这样取：

```bash
npm pack @ip-location-db/dbip-country-mmdb
```

解开后把 `dbip-country.mmdb` 放到服务器上，设 `TENUP_GEOIP` 指向它。库需要定期更新。没有库、查不到、或者是家里内网地址时，不会触发短信验证。

## 规则

- **首次设置**：设置口令 + 你的邮箱 + 密码（至少 10 位）+ 两个手机号，两个号码各验证一次。只能成功一次。这个邮箱就是第一个登录账号。
- **登录**：邮箱 + 密码。要不要再输短信验证码，由管理员在管理员设置里选：关闭 / 新设备或换了国家时（默认）/ 每次登录。
- **从旧版升级**：原来的家庭密码保留为一个没有邮箱的账号，登录时邮箱留空即可。升级后各设备要重新登录一次。
- **改手机号**：要改号码 A，验证码发到号码 B；通过后再向新号码发一次确认。没有别的途径能改。
- **防护**：密码连续输错 5 次锁 15 分钟；验证码 6 位、5 分钟有效、最多试 5 次；同一号码 60 秒内只发一次、每天最多 10 次。
- **加密**：每个照片、音频和相册数据都用 AES-256-GCM 单独加密。数据密钥被"密码派生的密钥"和"服务器主密钥"共同保护，两样缺一不可。
- **重启后**：数据处于上锁状态，任意设备用密码登录一次即解锁。

## 管理员

打开网站后在"照片管理"页面最下方点"管理员设置"（或直接打开 `admin.html`）。

- **第一次设置管理员**：已登录的账号 + 一个锁定手机号的短信验证码，然后用验证器 App（Google Authenticator、微软验证器等）扫码绑定，再设一个至少 12 位的管理员密码。
- **进入管理员设置**每次都要三样：管理员密码、验证器 App 上的 6 位动态码、发到两个锁定手机号之一的短信验证码。
- **管理员能做的事**：短信验证开关；添加登录账号（邮箱 + 密码）、改邮箱、改密码、移除账号；查看操作记录。
- **重新设置管理员**（忘了管理员密码、换了手机）：要两个手机号都收到验证码，完成后旧的管理员密码和验证器立即失效。
- **管理员状态只在服务器内存里**：15 分钟不操作、退出管理或服务器重启后，都要重新验证。连续输错 5 次锁 30 分钟。

## 两个手机号都丢了怎么办

没有任何接口能绕过短信验证，这是规则本身决定的。能登录服务器的人可以停掉服务，删除 `data/account.enc` 后重新做首次设置——但这样会同时丢掉数据密钥，**已有的照片将无法解密**。所以请确保两个手机号至少有一个长期可用，并及时用其中一个更换另一个。

## 备份

备份 `TENUP_DATA` 文件夹即可，里面全是密文。主密钥另外保存。丢了主密钥或忘了密码，数据无法恢复。

## 自检

```bash
node server/test/api.test.js
```

带上国家库可以把"换国家要重新验证"也测到：

```bash
node server/test/api.test.js /path/to/dbip-country.mmdb
```

## 没有做的事

- 没有清理不再被相册引用的旧文件，长期使用后数据文件夹会比实际需要的大一些。
- 没有经过专业安全审计，定位是家用。

### 视频

- 手机拍的视频（iPhone 的 `.mov`、安卓的 `.mp4`，以及 `.webm`、`.m4v`、`.3gp`）可以上传，每段默认不超过 500 MB。上传时边收边按段加密写盘，服务器内存占用和视频大小无关；一次上传最多可以用 60 分钟。
- 视频不是整块加密的：按 1 MB 一段分别用 AES-256-GCM 加密，段号写进校验，段不能被调换或删掉。播放时按需要的字节范围只解密用到的那几段，内存占用很小，拖动进度条也快。
- 存放方式：`files/<编号>.seg`（加密的视频分段）和 `files/<编号>.meta`（加密的类型和大小）。备份时和其他文件一样，整个数据文件夹拷走即可。
- 服务端不转码。iPhone 默认的 HEVC 视频在电视、iPhone、iPad、Mac 上能放；个别电脑浏览器放不了时，上传页会提示。想让所有设备都能放，可以在 iPhone 设置 → 相机 → 格式里选"兼容性最佳"。
