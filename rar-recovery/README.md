# 🔓 压缩包密码恢复工具（RAR / ZIP / 7z）

一个**在你自己电脑上本地运行**的小应用，用来找回你**自己忘记密码**的压缩包。
提供三种用法：

- 🖥️ **桌面应用（Electron）** — 双击即用，系统原生「选择文件」对话框。见 [`electron/README.md`](electron/README.md)
- 🌐 **网页界面** — `python3 serve.py`，浏览器里填路径/拖拽 → 自动破解 → 自动解压
- ⌨️ **命令行** — `python3 recover.py 文件.rar`，适合挂大字典长时间跑

三者共用同一套**已测试的破解引擎**（桌面应用只是 Electron 外壳，底层仍调用这里的 Python 引擎）。

> ⚠️ **仅限恢复你本人拥有的文件。** 破解他人文件的密码可能违法。

---

## 先了解：能不能成功，取决于密码强度

RAR / 7z 用的是强加密（RAR5 = AES‑256，还叠加了慢哈希 PBKDF2），**没有后门、没有万能钥匙**，
唯一的通用办法就是"自动去试密码"。所以：

| 你当年设的密码 | 恢复希望 |
| --- | --- |
| 常见弱密码（123456、生日、常用词…） | ✅ 很可能几分钟内破出 |
| 短密码 / 有规律（纯数字、词+年份） | 🟡 有机会，看长度和运气 |
| 随机长密码（12 位以上乱码） | ❌ 现实中基本无法恢复 |

这个工具会把成功率**拉到最大**：优先试你自己的猜测 → 几千个最常见密码 →
生日/日期 → 常见词+数字 → 纯数字穷举 → （可选）小字符集暴力。
破不出也帮你确认了"不是弱密码"。

---

## macOS 上手（3 步）

### 1. 安装解压后端（RAR 必需）

本工具靠系统的 `unrar` 实际测试 RAR 密码。用 [Homebrew](https://brew.sh) 安装：

```bash
brew install unrar          # RAR 支持（最推荐、最可靠）
# 可选：
brew install sevenzip       # 7z 支持（.7z 文件需要），也能兜底 RAR
pip3 install pyzipper        # 支持 AES 加密的 ZIP（.zip 一般无需系统工具）
```

> 只处理 `.zip` 的话，通常连 brew 都不用装（Python 自带 ZIP 支持；AES 加密的 zip 才需要 `pyzipper`）。

### 2. 启动网页应用

```bash
cd rar-recovery
python3 serve.py            # 会自动打开浏览器 http://127.0.0.1:8765
```

### 3. 在网页里操作

1. **填入压缩包的完整路径**（如 `/Users/你/Downloads/secret.rar`），或直接把文件**拖进去**；
2. 选择**搜索强度**（推荐先用「标准」）；
3. 记得点什么就填进「高级选项」的候选密码框（命中率大增）；
4. 点**开始破解**，实时看进度。找到后会**自动解压**到压缩包同目录的 `<包名>_unlocked/`。

---

## 命令行用法（等价、适合大字典/长时间跑）

```bash
cd rar-recovery

# 最简单：标准强度，自动识别格式、破解、解压
python3 recover.py ~/Downloads/secret.rar

# 快速过一遍常见密码
python3 recover.py secret.rar --strategy fast

# 把你记得的候选优先试（最有效！）
python3 recover.py secret.rar --guess 我的常用密码 生日19900101 13800138000

# 用外部大字典（如 rockyou.txt）
python3 recover.py secret.rar --wordlist ~/rockyou.txt

# 纯数字最长试到 8 位（手机号/长日期）
python3 recover.py secret.rar --digits-max 8
```

参数：

参数：

| 参数 | 说明 |
| --- | --- |
| `--strategy fast\|standard\|deep\|custom` | 搜索强度，默认 `standard`（给了暴力参数会自动转 custom） |
| `--guess A B C` | 你自己记得的候选密码，**最优先**尝试 |
| **第 1 级** | |
| `--no-keylib` | 跳过"关键数字字母库" |
| `--no-dates` | 不尝试生日/日期 |
| **第 2 级** | |
| `--no-industry` | 跳过内置行业常用库 |
| `--no-combos` | 跳过"常见词+数字"组合 |
| `--wordlist 文件` | 追加外部行业字典（rockyou 等，每行一个） |
| **第 3 级（暴力，范围可控）** | |
| `--digits-max N` | 纯数字穷举最大位数（0=关闭） |
| `--brute-charset` | `digits/lower/upper/alpha/loweralnum/alnum/alnumsym/custom` |
| `--brute-custom 串` | 自定义字符集（配合 `--brute-charset custom`） |
| `--brute-min N` / `--brute-max N` | 暴力长度区间（`--brute-max 0` = 不暴力） |
| `--workers N` | 并行线程数（0=自动，按 CPU 核数） |
| `--out 目录` / `--no-extract` | 解压目录 / 只找密码不解压 |

---

## 三级优先级（命中最快的先跑）

工具按"最可能命中"的顺序分三级产出候选，找到即停：

| 级别 | 内容 | 说明 |
| --- | --- | --- |
| 🔑 **第 0 级** | 你自己的候选（`--guess`） | 永远最先试 |
| 1️⃣ **第 1 级：关键数字与字母** | 顺子、重复、键盘走位（qwerty/1qaz2wsx）、吉利数（520/1314）、生日日期 | 真人最常设的"关键组合"，秒级覆盖 |
| 2️⃣ **第 2 级：行业常用密码库** | 内置高频库 + 常见词加数字 + 你挂的外部字典（rockyou/SecLists） | 安全行业沉淀的常用密码 |
| 3️⃣ **第 3 级：暴力生成（范围可控）** | 纯数字穷举 + 通用字符集×长度区间 | **每次可自定范围**：选字符集 + 定长度 `min~max`，分批推进 |

**范围可控的暴力示例**（每次只跑一个可控的空间，便于分批）：

```bash
# 只跑 6~8 位纯数字（手机号/长日期）
python3 recover.py x.rar --strategy custom --no-keylib --no-industry --no-combos \
  --brute-charset digits --brute-min 6 --brute-max 8

# 只跑 4~5 位小写字母
python3 recover.py x.rar --brute-charset lower --brute-min 4 --brute-max 5

# 自定义字符集：只在这些字符里暴力，长度 3~6
python3 recover.py x.rar --brute-charset custom --brute-custom 'abc123!@' --brute-min 3 --brute-max 6
```

网页/桌面版里，第 3 级会**实时显示这一批的组合数与预计耗时**，方便你把控每次范围。

**多核并行**：自动按 CPU 核数开多线程（每次尝试彼此独立），实测 4 核约 4×（38→155 次/秒），
8 核可到 ~300 次/秒。`--workers N` 手动指定。

即便如此，RAR/7z 受慢哈希限制，单机每秒也就几百次量级，所以**大范围暴力仍建议用 GPU 加速**（见下）。

---

## 想更快？用 hashcat 做 GPU 加速（进阶）

对于位数较多、需要真正暴力破解的情况，GPU 工具快几个数量级（Apple 芯片也支持）：

```bash
brew install hashcat john-jumbo

# 1) 从压缩包提取哈希（john-jumbo 自带 rar2john / zip2john）
rar2john secret.rar > hash.txt      # RAR
zip2john secret.zip > hash.txt      # ZIP

# 2) 字典攻击（-m 13000=RAR5，12500=RAR3，13600=WinZip AES，17200/17210=ZipCrypto）
hashcat -m 13000 hash.txt ~/rockyou.txt

# 3) 掩码攻击示例：8 位纯数字
hashcat -m 13000 -a 3 hash.txt '?d?d?d?d?d?d?d?d'
```

本工具的定位是**开箱即用地覆盖常见/弱密码**；hashcat 负责重型暴力。两者互补。

---

## 工作原理

```
压缩包 ──detect──> 识别格式(RAR4/RAR5/ZIP/7z) 与是否加密
        ──engine─> 选择后端：RAR→unrar，ZIP→Python(pyzipper)，7z→7z
        ──self_test──> 用随机错误密码自检：坏工具/未加密立刻暴露，绝不误报
        ──candidates─> 按"最可能命中"顺序产出候选密码
        ──尝试循环──> 逐个测试，实时进度；命中即停并自动解压
```

**可靠性保证**：
- 每次开跑先**自检**——用一个随机错误密码测试，若被判"正确"说明工具异常或压缩包没加密，直接报错而**不会误报**一个错密码。
- ZIP 传统加密（ZipCrypto）有 1/256 的头部碰撞弱点，本工具**完整读取并校验 CRC/HMAC**，杜绝误报（实测 2000 个错密码 0 误报）。

---

## 目录结构

```
rar-recovery/
├── serve.py            # 网页应用（纯标准库，无第三方依赖）
├── recover.py          # 命令行入口
├── recovery/           # 核心库
│   ├── detect.py       # 格式识别
│   ├── engines.py      # 各格式密码测试/解压引擎 + 自检
│   ├── candidates.py   # 候选密码生成
│   └── job.py          # 后台任务/进度管理
├── wordlists/common.txt# 内置常见弱密码
├── web/                # 网页前端（HTML/CSS/JS）
└── tests/              # 单元/集成测试
```

## 运行测试

```bash
cd rar-recovery
python3 tests/test_recovery.py       # 缺哪个工具就自动跳过对应格式
```

---

## 隐私

全程**本地运行**，网页只监听 `127.0.0.1`，你的压缩包和解出的文件**不会上传到任何服务器**。
