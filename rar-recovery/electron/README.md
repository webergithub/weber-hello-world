# 压缩包密码恢复 · 桌面版（Electron）

把[上一层的 Python 恢复引擎](../README.md)包装成一个**双击即用的桌面应用**：
原生窗口、系统「选择文件」对话框，底层复用同一套已测试的破解逻辑。

## 架构

```
Electron 主进程 (main.js)
   ├─ 启动时 spawn 后端：python3 -u serve.py --port 0   （复用 ../ 的 Python 引擎）
   ├─ 从后端输出里解析出 http://127.0.0.1:<随机端口>
   ├─ 在窗口中 loadURL 该地址（网页界面来自 ../web/）
   ├─ 提供原生「选择文件」对话框（preload.js → window.electronAPI.pickFile）
   └─ 退出时杀掉 Python 子进程
```

- 网页界面（`../web/`）会自动检测是否运行在 Electron 里：
  - 是 → 「选择文件」走**系统原生对话框**，拖拽也直接读**真实路径**（不复制、不上传）
  - 否 → 退回普通浏览器的上传方式
  所以同一套前端在浏览器和桌面应用里都能用。

## 先决条件

因为破解逻辑复用 Python 引擎，运行前需要：

1. **Python 3**（macOS：`brew install python`）
2. **unrar**（处理 RAR 必需；macOS：`brew install unrar`，或 `brew install sevenzip`）
3. 可选：`pip3 install pyzipper`（支持 AES 加密的 ZIP）

> 想做成完全不依赖用户机器 Python 的独立包？见文末「打包成独立应用」。

## 开发运行

```bash
cd rar-recovery/electron
npm install          # 安装 electron / electron-builder
npm start            # 启动桌面应用
```

启动后会先显示「正在启动…」，等本地引擎就绪后自动进入主界面。
若报「启动失败」，多半是没装 Python 3 或 unrar，按提示安装即可。

如果你的 `python3` 不在 PATH 里，可以指定：

```bash
RAR_RECOVERY_PYTHON=/opt/homebrew/bin/python3 npm start
```

## 打包成安装包

```bash
npm run dist         # 按当前系统打包
npm run dist:mac     # macOS → .dmg
npm run dist:win     # Windows → 安装程序
npm run dist:linux   # Linux → AppImage
```

产物在 `dist/`。打包时会通过 `extraResources` 把 `../serve.py`、`../recovery`、
`../web`、`../wordlists` 一并放进应用的 `resources/backend/`，`main.js` 在打包态
会从那里找后端。

> 打好的包**仍需用户机器上有 Python 3 与 unrar**。

## 让它完全独立（不依赖用户的 Python，进阶）

如果要分发给非技术用户、不想让对方装 Python，可以先把后端用 PyInstaller
冻结成一个可执行文件，再让 Electron 调它而不是调 `python3`：

```bash
pip3 install pyinstaller pyzipper
cd rar-recovery
pyinstaller --onefile --name rar-backend \
  --add-data "web:web" --add-data "wordlists:wordlists" serve.py
# 得到 dist/rar-backend，把它作为 extraResources 打进 Electron，
# 并把 main.js 里的 spawn('python3', ['serve.py', ...]) 改成 spawn(冻结后的二进制, [...])。
```

`unrar` 仍需系统提供（或一并随包分发 unrar 二进制并在调用时指向它）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `main.js` | 主进程：拉起后端、建窗口、原生对话框、生命周期 |
| `preload.js` | 安全地把 `window.electronAPI` 暴露给网页 |
| `loading.html` | 启动等待页 / 启动失败提示页 |
| `package.json` | 依赖与 electron-builder 打包配置 |
