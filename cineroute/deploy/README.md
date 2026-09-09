# 部署到服务器

面向 Oracle Cloud（Oracle Linux，默认登录用户 `opc`）写的，Ubuntu / Debian 也能用——
`install.sh` 会自己认包管理器。

CineRoute 是零依赖的 Node 项目，**不需要 `npm install`，不需要构建**。
部署实际上就是：拉代码 → 建服务账号 → systemd 起进程 → Nginx 反代。

---

## 一次装好

在服务器上：

```bash
git clone --depth 1 -b claude/movie-tv-search-platform-gwzo4k \
  https://github.com/webergithub/weber-hello-world.git /tmp/cineroute-src
sudo bash /tmp/cineroute-src/cineroute/deploy/install.sh
```

脚本做这些事，重复执行不会破坏已有配置：

| 步骤 | 结果 |
|---|---|
| 装 Node 22 | 已有 Node ≥18 就跳过 |
| 建 `cineroute` 系统账号 | 不可登录、无家目录 |
| 代码放 `/opt/cineroute` | root 所有、服务账号只读 |
| 数据放 `/var/lib/cineroute` | 下载产物 + `sources.json` |
| 生成 `/etc/cineroute.env` | 已存在则原样保留 |
| 装并启动 systemd 服务 | `systemctl status cineroute` |
| 自检 | 起不来就打印日志并退出非零 |

装完服务只监听 `127.0.0.1:8787`，从外面还访问不到——要过 Nginx。

---

## 再配 Nginx

```bash
# Oracle Linux / RHEL
sudo cp /opt/cineroute/deploy/nginx.conf /etc/nginx/conf.d/cineroute.conf
# Ubuntu / Debian
sudo cp /opt/cineroute/deploy/nginx.conf /etc/nginx/sites-available/cineroute
sudo ln -sf /etc/nginx/sites-available/cineroute /etc/nginx/sites-enabled/

sudo nginx -t && sudo systemctl reload nginx
```

改完**一定先 `nginx -t` 再 reload**，别直接 restart——配置写错的话 restart 会让服务直接停掉。

### 三个容易踩的坑

**① SELinux 不放行 Nginx 对外连接**（Oracle Linux 默认开着）。
不设这个开关反代会 502，错误日志里写的是 `Permission denied`：

```bash
sudo setsebool -P httpd_can_network_connect 1
```

**② 端口要放行两个地方**，只改一个不通：

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

外加**云控制台里 VCN 的安全列表 / NSG 入站规则**——这一步在网页上做，脚本管不了。
这是 OCI 上最常见的「服务明明起来了就是访问不到」的原因。

**③ IPv6**。`nginx.conf` 里的 `listen [::]:80` 默认是注释掉的。
OCI 的 VCN 默认不开 IPv6，打开这行会让 Nginx 直接起不来
（`socket() [::]:80 failed (97: Address family not supported by protocol)`）。
实例确实启用了 IPv6 再取消注释。

---

## 挂公网前必须知道的一件事

**这套接口没有任何登录认证。** 具体说：

- `/media?url=…` 会用你服务器的带宽去取归档站视频再转发给请求方；
- `/api/download` 会让你的服务器把文件下载到 `/var/lib/cineroute/downloads`。

两个接口都有域名白名单（只放行 archive.org / Wikimedia，内网地址和 `file://`
一律拒绝，这点我实测过），所以**不会**被拿去打内网或读本地文件。
但**会**被拿去白嫖你的带宽和磁盘。

直接对公网开之前，在 `nginx.conf` 里二选一打开：

```nginx
# (a) 加密码
auth_basic           "CineRoute";
auth_basic_user_file /etc/nginx/.cineroute.htpasswd;

# (b) 只放行自己的 IP
allow 203.0.113.7;
deny  all;
```

建密码文件：

```bash
sudo dnf install -y httpd-tools          # Ubuntu: apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.cineroute.htpasswd 你的用户名
```

---

## 日常运维

```bash
# 更新到分支最新（跑测试 → 通过才上线 → 失败自动回滚）
sudo /opt/cineroute/deploy/update.sh

# 只看有没有更新，不动线上
sudo /opt/cineroute/deploy/update.sh --check

# 改配置（API key、端口、取数默认值…）
sudo vi /etc/cineroute.env && sudo systemctl restart cineroute

# 看日志
journalctl -u cineroute -f

# 看当前检索来源配置
sudo -u cineroute CINEROUTE_CONFIG=/var/lib/cineroute/sources.json \
  node /opt/cineroute/index.js --sources
```

`update.sh` 会在同步代码前把测试跑一遍（155 个用例，全部离线，几秒钟），
不过就不上线、线上代码一个字节都不动。同步之后如果服务起不来或接口自检不通过，
自动回滚到更新前的代码。

---

## HTTPS

有域名的话用 certbot，它会自动改写 `nginx.conf` 里的 server 块：

```bash
sudo dnf install -y certbot python3-certbot-nginx    # Ubuntu 换 apt-get
sudo certbot --nginx -d cineroute.example.com
```

---

## 目录约定

| 路径 | 内容 | 权限 |
|---|---|---|
| `/opt/cineroute` | 代码 | root 所有，服务只读 |
| `/opt/cineroute-src` | git 工作副本（`update.sh` 用） | root |
| `/var/lib/cineroute/sources.json` | 检索来源配置 | 服务可写 |
| `/var/lib/cineroute/downloads` | 下载产物 | 服务可写 |
| `/etc/cineroute.env` | 环境变量（含 API key） | `640 root:cineroute` |

systemd 单元开了 `ProtectSystem=strict`，整个文件系统对服务只读，
只有 `/var/lib/cineroute` 在 `ReadWritePaths` 里——所以服务改不了自己的代码，
配置也必须放在 `/var/lib`，不能用仓库里默认的 `config/sources.json`。
`install.sh` 生成的 env 文件里已经把 `CINEROUTE_CONFIG` 指对了。
