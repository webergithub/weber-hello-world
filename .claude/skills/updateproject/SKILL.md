---
name: updateproject
description: 将本项目（CityTwin 城市猎手）部署/更新到 Weber 的服务器并验证。当用户要求"部署/上传/更新到服务器/opc服务器/deploy"时使用。云端会话走 GitHub Actions 触发 deploy.yml 并核对运行日志；本地会话（Mac/Windows，有 SSH 私钥）直接 rsync/scp。
---

# updateProject — CityTwin 部署到服务器

自动化流水线：**commit/push → 部署到 VM → 验证**（纯静态项目，无需 build）。

## 服务器配置（来源：Google Drive 0_publicfolder/updateProject.md）

| 变量 | 值 |
|------|----|
| serverUser | `ubuntu` |
| serverHost | `145.241.235.191` |
| deployBase | `/home/ubuntu/website` |
| moduleName | `citytwin` |
| 部署目标 | `/home/ubuntu/website/citytwin/` |
| SSH 私钥（仅本地机器有） | `D:\claudeSpace\ssh-key-2026-05-05.key`（Windows）/ Mac 对应钥匙串路径 |
| 访问地址 | `http://145.241.235.191/citytwin/`（挂在主站 nginx 下） |

需要部署的文件（纯静态，无构建步骤）：`index.html game.js cities.js lib/ data/ README.md`

## 强制规则

1. **先提交再部署**：部署前必须 `git add -A && git commit && git push`，保证服务器内容和仓库一致；
2. **部署后必须验证**：确认目标目录 `index.html` 存在且非空，报告访问地址；
3. **私钥绝不进对话/代码/日志**：私钥只存在于本地磁盘和 GitHub Secrets `DEPLOY_SSH_KEY`。

## 路径 A · 云端会话（Claude Code on the web —— 沙箱不能出站 SSH）

用 GitHub Actions 部署（仓库已有 `.github/workflows/deploy.yml`）：

1. 前置（一次性）：仓库 Settings→Secrets and variables→Actions 需已配置
   `DEPLOY_HOST=145.241.235.191` · `DEPLOY_USER=ubuntu` · `DEPLOY_PATH=/home/ubuntu/website/citytwin` · `DEPLOY_SSH_KEY=<私钥全文>`；
2. 触发：用 GitHub MCP 的 `actions_run_trigger`（method=run_workflow, workflow_id=deploy.yml, ref=当前分支）；
   或依赖 push 自动触发；
3. 验证：`actions_list`（list_workflow_jobs）查看最新 run —— **"Deploy via rsync" 步骤必须是 success 而非 skipped**；
   skipped = Secrets 未配置，须提醒用户补齐后重跑；
4. 向用户报告访问地址 `http://145.241.235.191/citytwin/`。

## 路径 B · 本地会话（Mac / Windows，有私钥文件）

```bash
# Mac/Linux（私钥路径按本机实际调整）
KEY=~/claudeSpace/ssh-key-2026-05-05.key
ssh -i "$KEY" -o StrictHostKeyChecking=no ubuntu@145.241.235.191 "mkdir -p /home/ubuntu/website/citytwin"
rsync -avz -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  index.html game.js cities.js lib data README.md \
  ubuntu@145.241.235.191:/home/ubuntu/website/citytwin/
# 验证
ssh -i "$KEY" ubuntu@145.241.235.191 "ls -lh /home/ubuntu/website/citytwin/index.html && echo VERIFY_OK"
```

```powershell
# Windows PowerShell
$key = "D:\claudeSpace\ssh-key-2026-05-05.key"
ssh -i $key -o StrictHostKeyChecking=no ubuntu@145.241.235.191 "mkdir -p /home/ubuntu/website/citytwin"
scp -i $key -o StrictHostKeyChecking=no -r index.html game.js cities.js lib data README.md `
  ubuntu@145.241.235.191:/home/ubuntu/website/citytwin/
ssh -i $key ubuntu@145.241.235.191 "ls -lh /home/ubuntu/website/citytwin/index.html && echo VERIFY_OK"
```

## 主页「孪生」模块入口

`deploy/homepage-card.html` 里的 `<a class="ct-card">…</a>` 片段粘贴进主页孪生模块栅格，
链接指向 `/citytwin/` 即可点击进入游戏。
