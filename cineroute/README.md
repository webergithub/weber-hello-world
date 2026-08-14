# CineRoute 影路 🎬

**一次输入片名 → 多源并发检索 → 深度解析真实片源直链 → 可解释打分排 Top5 → 点开即播 / 勾选离线下载**

零依赖（不需要 `npm install`），Node 18+ 直接跑。

```bash
cd cineroute
node index.js --offline "Night of the Living Dead"   # 离线夹具，无需联网与 API key
node index.js --serve                                 # 启动 Web 界面 http://localhost:8787
npm test                                              # 198 个用例，全部离线
```

---

## 检索范围（重要）

本工具检索**公有领域、自由许可（CC / PD）与你自己的媒体库**。
对受版权保护的作品，只返回"去哪能合法看"的正版渠道，**不解析、不提供播放地址**。

这不是一句免责声明，而是写在代码结构里的边界：数据源必须在
[`src/adapters/registry.js`](src/adapters/registry.js) 显式登记，媒体代理与下载接口共用同一份域名白名单。
背后的技术与法律判定见 [`docs/01-调研洞察.md`](docs/01-调研洞察.md)。

---

## 它解决什么问题

搜片源的痛点从来不是"搜不到"，而是**结果里全是噪声**：死链、预告片、片段、
浏览器根本放不出来的容器。CineRoute 的核心是一个会**说明理由**的排序器：

```
🏆  Top5 推荐（前 3 位可直接播放 · 后 2 位正版订阅/付费）

  #1  ▶ 直接播放   96.6 分   Internet Archive
      notld_restored_1080p.mp4
      MP4 · 1080p · 1h36m · 1.95 GB
      https://archive.org/download/notld_1968_restored_4k/notld_restored_1080p.mp4
        可播性       30/30  MP4/H.264 全平台原生可播；支持 Range，可拖动进度条与断点续传
        清晰度     22.9/26  1440×1080
        完整度       22/22  96 分钟，与参考片长 96 分钟一致
        码率         8/8   2906 kbps · 1.95 GB，码率理想
        来源可信      10/10  公有领域；收录于 feature_films 馆藏
        人气       3.7/4   412,907 次下载

  #4  🎟️  订阅可看   AMC+
      需在该平台订阅或付费后观看（US 区）
      https://www.themoviedb.org/movie/10331/watch?locale=US

📦  备选（浏览器放不了，但可下载后本地播放）
    · night_of_the_living_dead.mkv     原因：Matroska 浏览器不支持，可下载后本地播放
    · night_of_the_living_dead_trailer.mp4  原因：标题含「trailer」，判定为非正片
```

## 推荐位规则

| 位次 | 内容 | 行为 |
|---|---|---|
| **1 – 3** | 可直接播放的片源 | 点开即播，可离线下载 |
| **4 – 5** | 需订阅或付费的正版渠道 | 跳转官方观看页（订阅 → 租赁 → 购买 → 广告免费） |

两侧不足时互相回填：直链不足 3 条则正版渠道往前顶；未取到正版渠道（未配置
`TMDB_API_KEY` 或该片无正版上架）则用更多直链补满，并在「说明」里注明原因。

---

## 五步走：每一步的中间结果都摊开

界面上是五个 tab，检索完可以逐步倒查。这不是为了好看——调研取证要能回答
「这个地址是怎么来的、中间被谁筛掉了」，只给最终结果等于把证据链掐断。

| Tab | 内容 | 关键点 |
|---|---|---|
| **① 引擎原始结果** | 五个引擎 × 每个检索词的原始返回，分引擎分词列出 | **不去重、不筛选**，看到的就是引擎原样返回的 |
| **② 归一去重** | 跨引擎合并，每组展开可见合并了哪些来路 | 优先按 md5/sha1 合并（校验和相同就是同一文件，与 URL 无关） |
| **③ 嗅探甄别** | 逐条给出可用/筛除的结论、原因、HTTP 实测结果 | 每条下方附**引用**：哪个引擎、用哪个词、第几名、从哪个页面找到的 |
| **④ 最终结果** | 打分排序后的 Top5 + 备选 + 正版渠道 | 就是原来的推荐结果 |
| **⑤ 模拟打开验证** | 真在无头浏览器里打开、拖进度条、截 8 张图、多线程模拟下载 | **唯一真正解码的一步**；全失败会自动开下一轮 |

第三步会如实报告「嗅探了几条 / 共几条」——超出探测配额的条目标为「未探测」，
按上游元数据判定，不会让人误以为全部实测过。配额用 `probeLimit` 调（默认 24）。

### 第五步做了什么

前四步都停在"根据元数据和 HTTP 头判断"。地址活着、Content-Type 对、支持 Range，
不等于**放得出画面**——容器对但编码不支持、有音轨没视轨、文件截断、
声称 1080p 实际是 640×480 拉上去的，这些在 HTTP 头里全看不出来。

所以第五步用无头 Chromium 真打开一遍：

- **加载耗时**：拿到元数据 / 首帧数据 / 可开始播 / 缓冲够播完 各用了多久，卡顿几次
- **8 个时间点截图**：开头、1 分钟、5 分钟、10 分钟、30 分钟、60 分钟、90 分钟、片尾前 5 分钟。
  每张都记录**实际落点**——请求 30 分钟却停在 20 秒，说明这个副本拖不动
  （缺时长索引、被截断、或服务端不认 Range），这时的画面不代表那个时间点，会被标为无效
- **清晰度识别**：每帧算拉普拉斯方差（判模糊的标准做法）+ 对比度，取非空白帧的中位数
- **实际解码分辨率**：与上游标称对照。标 1080p 实际解码 360p 会被当场点出来
- **多线程模拟下载**：默认 5 线程，各取一段 Range，测吞吐、验区间是否对得上。
  只取样不落盘——调研要的是"能不能下、多快"，为这个把几个 GB 拉完没必要

**清晰度评级是批内相对的，不是绝对阈值。** 拉普拉斯方差强烈依赖画面内容：
密集纹理的战争片天然比柔光文艺片高一个数量级。实测同一幅图加不同模糊：
0px→19977、1px→1525、2px→251、4px→61，0–4px 区间区分度极高，再糊下去就饱和。
所以拿一套绝对阈值卡不同片子必然误判——而第五步比较的本来就是**同一部片的不同副本**，
横向比才是对的。排序主依据是解码出来的真实分辨率（客观事实），细节密度用来分同分辨率的高下、
以及戳穿"标着高分辨率其实是放大的"。

**全军覆没就自动换下一批。** Top-N 全都既放不出也下不下来时，取接下来的 N 个候选再验一轮，
最多 `maxRounds` 轮（默认 10，可配）。历史轮次在界面上折叠，只展开当前轮。

### 检索词扩展

一个片名只搜一次不够：归档站上传者起的标题五花八门。所以每次检索会自动扩展：

- **近似词**（本地生成，不花配额）：加年份（区分同名重拍）、精确短语、
  `full movie` / `完整版` 后缀、去掉英文前置冠词
- **推荐搜索词**（引擎返回的相关搜索）：第一轮顺手收下，过滤掉跑题的，
  再补搜一轮。只保留还带着原片名的——否则第二轮会拿一堆无关词去搜，白烧配额

词数直接决定 SERP 花多少钱（词数 × 引擎数 × 页数），所以有预算上限，
默认 4 个近似词 + 3 个推荐词，可在配置里的 `expand` 调。

---

## 检索来源（可配置，不写死）

跑哪些源、每个源取前多少条，全部存在 `config/sources.json`，
不在代码里。Web 界面的「🔎 检索来源」面板可直接勾选、改数量、加新源；
也可以直接改文件。命令行看当前配置：`node index.js --sources`。

**出厂默认**（全部勾选）：

| 来源 | 默认取数 | 产出 | 需要配置 |
|---|---|---|---|
| **Google 搜索** | 前 100 条 | 站点范围内的页面 → 交给解析器 | SERP 服务 |
| **Bing 搜索** | 前 100 条 | 同上 | SERP 服务 |
| **百度搜索** | 前 100 条 | 同上 | SERP 服务 |
| **Yandex 搜索** | 前 100 条 | 同上 | SERP 服务 |
| **DuckDuckGo 搜索** | 前 100 条 | 同上 | SERP 服务 |
| **Internet Archive** | 前 8 个条目 | 公有领域长片的真实直链（含 md5/sha1/时长/分辨率） | 否 |
| **Wikimedia Commons** | 前 20 条 | PD / CC 影像直链 | 否 |
| **Jellyfin** | 前 20 条 | 你自己媒体库里的内容 | `JELLYFIN_URL` `JELLYFIN_API_KEY` |
| **TMDB** | 1 条 | 权威片长与海报 + 正版观看渠道（数据来源 JustWatch） | `TMDB_API_KEY` |

数量是**逐源**的：可以 Google 前 100、百度前 30、Bing 前 50；没单独设的走全局默认
（`CINEROUTE_DEFAULT_LIMIT`，默认 100）。未配置的源自动跳过并说明缺什么，不影响其余源。
加新的专用源只需写一个导出 `adapter` 的模块并在 `BUILTIN_ADAPTERS` 登记；
加新引擎在界面上填个名字就行。

### 引擎来源的两件事要先说清楚

**一、这五个引擎都没有能直接用的免费官方 API。** Google 的 Web Search API 早已停用，
Bing 的 2025 年 8 月退役，DuckDuckGo 没有官方搜索 API，百度和 Yandex 的不对外。
所以检索做成**三种可插拔后端**，用 `CINEROUTE_SERP_BACKEND` 选：

| 后端 | 怎么工作 | 代价 |
|---|---|---|
| `api` | 调 SERP 服务（serper / brave / 自定义 URL 模板） | 稳，但按次收费 |
| `cli` | 调本机命令行工具，如 `ddgr --json -n {limit} {query}` | 免费，但要机器上装了才有 |
| `browser` | 无头 Chromium 打开结果页，从 DOM 里取 | 免费、不用装东西，但**脆** |

`browser` 后端要说明白：页面结构一改就得跟着改，引擎也有反自动化检测，量一大会被要求验证码
（页面正文过短或标题含验证字样时会如实标记 `suspectBlocked`）。适合小批量调研，
不适合当生产管道。想要免费又稳的，推荐**自建 SearXNG**——开源元搜索，聚合 Google/Bing/DDG，
自己部署一个，用 `api` 后端的 `custom` 模板或 `browser` 后端的 `CINEROUTE_SERP_URL` 指过去即可。

`cli` 后端的命令模板**不走 shell**：按空白拆成 argv 后逐个参数替换占位符，
所以查询词里有 `;`、`&&`、反引号都只会被当成一个普通参数，注入不了。

三种都没配就在结果里如实标为「已跳过」，而不是假装搜过。

**二、引擎检索限定在站点范围内。** 不限定域名地搜片名再抓视频地址，搜出来的绝大部分是盗版站，
这不是本项目要做的事。默认范围是归档站域名列表（archive.org、Commons、国会图书馆、
Europeana、荷兰开放影像……），作用是补上还没写专用适配器的那些站。范围可以自己增删。

引擎只负责**发现页面**，把页面变成播放地址交给结构化解析器：
`archive.org/details/{id}` 走 IA metadata API，Commons 文件页走 imageinfo。
域名对不上解析器的，只列进「引擎发现但未解析的页面」，**不抓取、不猜**。
所以加多少个引擎、站点范围里写什么，都不会扩大播放/下载的域名白名单。

---

## 三个值得一看的设计

**可播性是硬门槛，清晰度与片长决定排位。**
4K 的 MKV 在浏览器里是黑屏，480p 的 MP4 立刻出画面——所以不可播容器直接踢出推荐位进备选区，
而不是靠扣分让它沉底（扣分挡不住 4K MKV 靠清晰度分挤进第一）。
但在**都能播**的候选之间，排序由清晰度（26 分）与片长完整度（22 分）主导，合计高于可播性的 30 分。
片长完整度是**不对称**的：短于参考片长按缺失比例扣分，达到或超过则给满分——
更长的版本通常是未删减版或修复加长版，不是缺陷；两个都完整时，更长的那个胜出。

权重可覆盖：`CINEROUTE_WEIGHTS="resolution=30,completeness=25" node index.js "片名"`。

**两趟排名，把探测成本压到常数级。**
上游声称"这是个 mp4"不等于它能播。先用元数据预排名选出前 N（默认 24），只对这些发
`HEAD` / `Range: bytes=0-1` 探测真实可达性与 Range 支持，再带结果重排。

**没有 API key 也能挡住预告片。**
识别预告片需要参考片长。没有 TMDB key 时取所有候选时长的**中位数**——
归档站里正片副本通常多于预告片副本，中位数天然落在正片上。
实测零配置推定出 5754 秒（96 分钟），与真实片长一致。

---

## 离线下载

Range 分块并发（默认 8MB × 4 并发）+ 断点续传 + 完成后用上游 md5/sha1 自动校验。
进度记录在 `<文件名>.cineroute.json`，进程重启能接着下；服务端不支持 Range 时自动退化为单流。
校验不通过的文件**不会**被重命名为成品——静默损坏的视频往往播到一半才爆。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CINEROUTE_CONFIG` | `./config/sources.json` | 检索来源配置文件路径 |
| `CINEROUTE_DEFAULT_LIMIT` | `100` | 全局默认取数（源没单独设时用） |
| `CINEROUTE_SERP_BACKEND` | 无 | 检索后端：`api` / `cli` / `browser` |
| `CINEROUTE_SERP_PROVIDER` | 无 | `api` 后端的服务商：`serper` / `brave` / `custom` |
| `CINEROUTE_SERP_CMD` | 无 | `cli` 后端的命令模板，如 `ddgr --json -n {limit} {query}` |
| `CINEROUTE_SERP_CMD_FORMAT` | `json` | CLI 输出格式：`json` / `jsonl` / `lines` |
| `CINEROUTE_CHROME` | 自动查找 | Chromium 路径（`browser` 后端与第五步用） |
| `CINEROUTE_SERP_KEY` | 无 | 上述服务的 API key |
| `CINEROUTE_SERP_URL` | 无 | `provider=custom` 时的 URL 模板，占位符 `{query}` `{engine}` `{limit}` `{page}` `{key}` |
| `CINEROUTE_PORT` | `8787` | Web 服务端口 |
| `CINEROUTE_HOST` | `0.0.0.0` | 监听地址。放在反代后面设 `127.0.0.1`，否则应用端口自己也对外开着 |
| `CINEROUTE_DOWNLOAD_DIR` | `./downloads` | 下载目录 |
| `CINEROUTE_REGION` | `US` | 正版渠道地区 |
| `CINEROUTE_LANGUAGE` | `zh-CN` | TMDB 语言 |
| `CINEROUTE_MAX_CONCURRENCY` | `6` | 全局出网并发上限 |
| `CINEROUTE_CHUNK_BYTES` | `8388608` | 下载分块大小 |
| `CINEROUTE_CHUNK_CONCURRENCY` | `4` | 单任务分块并发数 |

> 在需要 HTTP 代理的环境里，Node 内置 `fetch` 需显式开启：`NODE_USE_ENV_PROXY=1 node index.js --serve`。

---

## 目录结构

```
cineroute/
  index.js                  CLI 入口（检索 / 启动服务）
  src/core/
    pipeline.js             编排：并发 → 去重 → 两趟排名
    score.js                六维可解释打分引擎
    probe.js                真实可播性探测
    match.js                片名归一化与相似度（准入门槛）
    http.js                 超时 / 重试 / 全局并发闸
    sourceConfig.js         检索来源配置：勾选 / 逐源取数 / 站点范围 / 词扩展 / 验证预算
    expand.js               检索词扩展：近似词生成 + 推荐搜索词采集与过滤
    fixtureFetch.js         夹具驱动的 fetch 替身（离线演示与测试）
  src/adapters/
    registry.js             按配置装配适配器 + 播放/下载域名白名单
    searchEngine.js         引擎适配器工厂（页面 → 片源解析）
    serp.js                 三种检索后端：api / cli / browser
    internetArchive.js / wikimediaCommons.js / jellyfin.js / tmdb.js
  src/browser/
    cdp.js                  零依赖 Chrome DevTools Protocol 客户端（用 Node 内置 WebSocket）
  src/verify/
    playback.js             播放嗅探：加载计时 · 8 点截图 · 清晰度识别
    simDownload.js          多线程模拟下载：吞吐 · Range 区间校验
    deepVerify.js           第五步编排 + 多轮重试
  src/server/
    server.js               检索 API / 媒体代理 / SSE 进度 / 深度验证
    downloader.js           分块并发 + 断点续传 + 校验
  src/web/                  前端（原生 JS，无框架）
  fixtures/                 真实形状的上游响应夹具
  forensics.js              取证 CLI（同一性甄别 / 后期加工识别）
  src/forensics/            容器解析（MP4 / fMP4 / MKV）· 码率与 GOP 剖面 · 异常检测 · 编码溯源 · 母版比对 · 帧分析
  test/                     198 个用例，全部离线可跑（浏览器相关只测纯逻辑，不进 CI 开真浏览器）
  deploy/                   部署到服务器：systemd 单元 · Nginx 反代 · 安装/更新脚本
  docs/01-调研洞察.md        市场与技术调研、可行性判定、架构决策
```

---

## 部署到服务器

零依赖，所以部署就是拉代码 + systemd + Nginx 反代，不需要 `npm install` 也不需要构建。

```bash
git clone --depth 1 -b claude/movie-tv-search-platform-gwzo4k \
  https://github.com/webergithub/weber-hello-world.git /tmp/cineroute-src
sudo bash /tmp/cineroute-src/cineroute/deploy/install.sh
```

完整步骤、Nginx 配置、以及三个容易踩的坑（SELinux、OCI 安全列表、IPv6）
见 [`deploy/README.md`](deploy/README.md)。

> **挂公网前注意**：这套接口没有登录认证。`/media` 和 `/api/download` 有域名白名单
> （内网地址与 `file://` 一律拒绝），不会被拿去打内网，但会被拿去白嫖带宽。
> `deploy/nginx.conf` 里留了 Basic Auth 和 IP 白名单两种口子，二选一打开。

---

## 视频取证（独立模块）

面向权利方委托的盗版调查：拿到一个副本后，判定**是不是这部作品**、**被动过什么手脚**。

```bash
node forensics.js <嫌疑副本>                     # 单文件分析
node forensics.js <嫌疑副本> --reference <母版>  # 与母版比对，精确定位插入/缺失段
node forensics.js <嫌疑副本> --overlay           # 烧录水印/台标检测（需本机 ffmpeg）
```

只分析你已取得的本地文件，不负责获取——取证分析本就不该与样本获取耦合。

核心思路是**不解码任何一帧**：MP4 的 `stsz`/`stts`/`stss` 三张样本表拼起来，
就能还原逐秒码率剖面与 GOP 节奏；MKV 则从每个 `SimpleBlock` 的头里拿同样的信息。

插播广告是另一次编码的产物，这两条曲线必然同时突变；而打斗戏码率飙高只影响码率、
不影响 GOP——**要求双信号同时命中**挡掉了大部分误报。

支持的容器：MP4 / MOV / M4V、分片 MP4（从 HLS/DASH 重封装的副本，额外检测 `tfdt`
时间轴断点）、MKV / WebM。MP4 解析 2GB 的片子只读几 MB（跳过 `mdat`）；
MKV 没有集中索引，需要整文件扫描。

有参考母版时可做序列对齐，把插入段定位到秒：

```
🚩 00:10:00 – 00:10:20（20s）  置信度 100%  suspected-insert
      该段码率中位 6794 kbps，全片基线 1875 kbps（3.62×，稳健 z=19.9）
      同一时段关键帧间隔为 0.52s，全片为 2s——该段使用了不同的编码参数
      起止点均落在关键帧上，符合拼接特征
```

还包括编码溯源（x264 参数串、muxer 指纹、faststart、keyint 交叉校验）与证据固化
（sha256/md5 流式计算、时间戳、工具版本）。详见 [`docs/02-视频取证.md`](docs/02-视频取证.md)。

---

## 测试

```bash
npm test
```

用例跑的是**真实解析与打分代码路径**（只把网络换成磁盘夹具），下载器则对着一个
本地 HTTP 服务真下载，验证分块偏移、断点续传与校验和——这些用 mock 验证等于没验证。
