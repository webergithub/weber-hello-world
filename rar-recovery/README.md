# 🔓 压缩包密码恢复工具（RAR / ZIP / 7z）

一个**在你自己电脑上本地运行**的小应用，用来找回你**自己忘记密码**的压缩包。
提供两种用法：网页界面（上传/填路径 → 自动破解 → 自动解压）和命令行。

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

| 参数 | 说明 |
| --- | --- |
| `--strategy fast\|standard\|deep` | 搜索强度，默认 `standard` |
| `--guess A B C` | 你自己记得的候选密码，最优先尝试 |
| `--wordlist 文件` | 追加外部字典（每行一个密码） |
| `--digits-max N` | 纯数字穷举最大位数 |
| `--no-dates` | 不尝试生日/日期 |
| `--out 目录` | 解压输出目录 |
| `--no-extract` | 只找密码，不自动解压 |

---

## 搜索强度说明

| 强度 | 尝试内容 | 大致耗时 |
| --- | --- | --- |
| **快速** | 常见密码 + 生日/日期 + ≤4 位数字 | 几秒 ~ 几分钟 |
| **标准**（默认） | 再加 6 位数字 + 常见词加数字 | 几分钟 ~ 几十分钟 |
| **深度** | 再加 8 位数字 + 小字符集暴力 | 很慢，见下方 GPU 方案 |

RAR/7z 每秒只能试几十~几百个（受慢哈希限制），所以**大范围暴力请用 GPU 加速**。

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
