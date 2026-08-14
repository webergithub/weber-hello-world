---
name: updateproject
description: 将本项目（CityTwin 城市猎手）部署/更新到 Weber 的服务器并验证。当用户要求"部署/上传/更新到服务器/opc服务器/deploy"时使用。云端会话走 GitHub Actions 触发 deploy.yml 并核对运行日志；本地会话（Mac/Windows，有 SSH 私钥）直接 rsync/scp。
---

# updateProject — CityTwin 部署到服务器

自动化流水线：**commit/push → 部署到 VM → 验证**（纯静态项目，无需 build）。


> **EN 版本铁律（用户 2026-08-01 设定，全局适用）**：每次部署都必须交付完整的 EN 语言版本 —— 页面走 `opcstudio_lang` + `t()` + `applyLang()`；`config.json` 卡片的 `name`/`desc_en` 与新建 section 的 `label_en` 必须填全。上线前切到 EN 自检：导航、面板标题、按钮、列表、知识卡不得残留中文（专有名词写成 `TravelSky（中国航信）` 这类双语形式）。

## 服务器配置（来源：Google Drive 0_publicfolder/updateProject.md）

| 变量 | 值 |
|------|----|
| serverUser | `ubuntu` |
| serverHost | `145.241.235.191` |
| deployBase | `/home/ubuntu/website` |
| moduleName | `citytwin` |
| 部署目标 | `/home/ubuntu/website/citytwin/` |
| SSH 私钥（仅本地机器有） | Windows：`D:\claudeSpace\ssh-key-2026-05-05.key`；Mac：`0_publicfolder/ssh-key-2026-05-05.key`（`~/.ssh/config` 已配别名 `oracle-vm`/`opc`，可直接 `ssh oracle-vm`） |
| 访问地址 | **`https://opcstudio.cc/citytwin/`**（主站域名；xray 占 :443，非 VPN 流量回落到 nginx:8080）。直连备用 `http://145.241.235.191:8080/citytwin/`。⚠️ **端口 80 无监听**，`http://145.241.235.191/citytwin/` 打不开（skill 旧版写错，勿用） |

需要部署的文件（纯静态，无构建步骤）：`index.html game.js cities.js lib/ data/ photoreal/ README.md`

## 强制规则

1. **先提交再部署**：部署前必须 `git add -A && git commit && git push`，保证服务器内容和仓库一致；
2. **部署后必须验证**：确认目标目录 `index.html` 存在且非空，报告访问地址；
3. **私钥绝不进对话/代码/日志**：私钥只存在于本地磁盘和 GitHub Secrets `DEPLOY_SSH_KEY`。

## 路径 A · 云端会话（Claude Code on the web —— 沙箱不能出站 SSH）

用 GitHub Actions 部署（仓库已有 `.github/workflows/deploy.yml`）：

1. 前置（一次性）：仓库 Settings→Secrets and variables→Actions 只需配置 **1 个**
   `DEPLOY_SSH_KEY=<私钥全文>`（host/user/path 已内置进 deploy.yml，可选 secret 覆盖）；
2. 触发：用 GitHub MCP 的 `actions_run_trigger`（method=run_workflow, workflow_id=deploy.yml, ref=当前分支）；
   或依赖 push 自动触发；
3. 验证：`actions_list`（list_workflow_jobs）查看最新 run —— **"Deploy via rsync" 步骤必须是 success 而非 skipped**；
   skipped = Secrets 未配置，须提醒用户补齐后重跑；
4. 向用户报告访问地址 `https://opcstudio.cc/citytwin/`。

## 路径 B · 本地会话（Mac / Windows，有私钥文件）

一键脚本：`bash deploy/mac-deploy.sh`（自动定位私钥→拉最新代码→rsync→验证）。手动等价命令：

```bash
# Mac/Linux —— Weber 的 Mac 已在 ~/.ssh/config 配好别名 oracle-vm/opc（私钥在 0_publicfolder/），用别名最省事
rsync -avz index.html game.js cities.js lib data README.md \
  oracle-vm:/home/ubuntu/website/citytwin/
ssh oracle-vm "ls -lh /home/ubuntu/website/citytwin/index.html && echo VERIFY_OK"
# 若无别名，退回显式私钥（路径按本机实际调整）：
#   KEY=/path/to/ssh-key-2026-05-05.key   # 需 chmod 600
#   rsync -avz -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
#     index.html game.js cities.js lib data README.md ubuntu@145.241.235.191:/home/ubuntu/website/citytwin/
```

```powershell
# Windows PowerShell
$key = "D:\claudeSpace\ssh-key-2026-05-05.key"
ssh -i $key -o StrictHostKeyChecking=no ubuntu@145.241.235.191 "mkdir -p /home/ubuntu/website/citytwin"
scp -i $key -o StrictHostKeyChecking=no -r index.html game.js cities.js lib data README.md `
  ubuntu@145.241.235.191:/home/ubuntu/website/citytwin/
ssh -i $key ubuntu@145.241.235.191 "ls -lh /home/ubuntu/website/citytwin/index.html && echo VERIFY_OK"
```

## 主页入口注册（配置驱动 —— 通用规则）

> 泛化规则：opcstudio.cc 主页的项目卡片**不是手写 HTML**，而是由
> `/home/ubuntu/website/config.json` 的 `modules` 数组动态渲染（invite-api 每次请求实时
> `loadCfg()` 读取，改文件即时生效）。因此 `deploy/homepage-card.html` 仅作独立视觉预览，
> **不要**再往主页 HTML 里贴卡片。

**要让任意项目在主页出现入口** → 在 `config.json` 的 `modules` 里、对应 `section` 下
**新增一个 module 卡片对象**（只新增，切勿改动/复用已有卡片的指向），再用 `deploy-config.sh` 部署。
CityTwin 已注册在「数字孪生」区（`section=digital-twin`），与电梯/机场/House 孪生并列。

section id 一览：`digital-twin`(数字孪生) · `projects`(项目) · `agents`(智能体) ·
`assist`(助手) · `guide`(建站指南) · `games-2d` · `games-3d`。

module 字段模板（静态、公开、无邀请码的项目）：

```jsonc
{
  "id": "citytwin", "name": "CityTwin", "name_zh": "城市数字孪生",
  "icon": "🏙️",
  "desc_zh": "……", "desc_en": "……",
  "tags": ["Three.js", "Digital Twin", "Game"],
  "section": "digital-twin",   // 卡片归属的区
  "status": "live",            // live=可点击；soon=灰色「即将推出」
  "requireInvite": false,      // true 则点击弹邀请码
  "visible": true,
  "order": 4,                  // 区内排序
  "path": "/citytwin/",        // 相对路径 → 服务器 /home/ubuntu/website/citytwin/
  "isProxy": false             // 反代到本地端口时置 true 并加 "proxyTarget"
}
```

部署配置（本地 Mac，已配 `oracle-vm` 别名）：

```bash
# 1) 编辑本地镜像（与线上 config.json 字节同步）：
#    0_publicfolder/server-projects/website-static/config.json
# 2) 带门禁部署：校验 JSON → 减量门禁(防误删 section/module) → scp → 重启 invite-api → 验证 API
cd 0_publicfolder && bash deploy-config.sh
# 3) 验证卡片已上线：
ssh oracle-vm 'curl -s http://127.0.0.1:3100/api/config/modules' | grep -o citytwin
curl -s -o /dev/null -w '%{http_code}\n' https://opcstudio.cc/citytwin/   # 期望 200
```

> 也可用后台 UI：`https://opcstudio.cc/admin/`（`config.json` 里的 `adminPassword`），改动同样落到 `config.json`。

### 设为「邀请码才可访问」（`requireInvite`）

⚠️ **关键坑**：邀请码门禁有两层——① `config.json` 里 `requireInvite:true`（让主页点击弹邀请码框）；
② nginx 的 `auth_request /api/invite/check` 块（拦截**直接访问 URL**，无 `opcstudio_invite` cookie 就 302 跳
`/?auth=required`）。第 ② 层由 invite-api 的 `applyNginx()` 重新生成，而 **`deploy-config.sh` 不会重载 nginx**
（只重启 invite-api）。所以只跑 deploy-config.sh 改 `requireInvite`，直链仍然裸奔！

**正确做法**：走管理 API `PUT /api/admin/modules`（内部会 `saveCfg` + 重新生成并 reload nginx）。在服务器本机执行：

```bash
ssh oracle-vm 'python3 - <<PY
import json,urllib.request
cfg=json.load(open("/home/ubuntu/website/config.json"))
def call(path,obj,method,tok=None):
    h={"Content-Type":"application/json"};  tok and h.update({"Authorization":"Bearer "+tok})
    r=urllib.request.Request("http://127.0.0.1:3100"+path,json.dumps(obj).encode(),method=method,headers=h)
    return json.load(urllib.request.urlopen(r))
tok=call("/api/admin/login",{"password":cfg["adminPassword"]},"POST")["token"]
for m in cfg["modules"]:
    if m["id"]=="citytwin": m["requireInvite"]=True    # 或 False 取消门禁
print(call("/api/admin/modules",{"modules":cfg["modules"]},"PUT",tok))   # 期望 {"ok":true,"nginxReloaded":true}
PY'
```

验证：`curl -so/dev/null -w '%{http_code}' https://opcstudio.cc/citytwin/` 无 cookie 应为 **302**；
带 `--cookie opcstudio_invite=<有效码>` 应为 **200**。邀请码在 `config.json` 的 `inviteCodes[]`，可在后台 `/admin/` 增删。
`path` 前缀会连同 `game.js`/`data/`/`cities.js` 等所有子资源一起保护。
