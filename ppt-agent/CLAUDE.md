# PPT智能体（ppt-agent）开发约定

## 每次迭代必须做的事（用户要求）

每次根据用户指令迭代功能后：

1. 刷新需求文档 `docs/需求文档.md`：版本号、变更记录、需求清单（新需求加编号与状态），并用 `pandoc docs/需求文档.md -o docs/需求文档.docx` 生成 Word 版。
2. `package.json` 的 `version` 递增，与需求文档版本一致。
3. 运行 `npm test`，并用 Playwright 驱动界面验证改动（`xvfb-run`）。
4. 打包 Windows exe：`npx vite build && npx electron-builder --win portable --x64 --publish never`，把产物复制到 `download/`（删除旧版本 exe，保持只有一个）。同步更新 README 中的下载文件名。
5. 提交并推送到 GitHub，然后在对话中发送 exe 与需求文档给用户下载；同时给出 GitHub 直接下载链接（`https://github.com/webergithub/weber-hello-world/raw/claude/trusting-dijkstra-6yrvoy/ppt-agent/download/<exe 文件名>`，仓库为公开仓库，不需要登录），README 中的直接下载链接同步更新。对话中的大文件（约 92MB）可能下载失败，需要时可另外发送分段文件（`split` 成约 33MB 的 .bin + `合并.cmd` 用 `copy /b` 合并）。
6. 新功能同步更新帮助：`PageHelp.jsx` 的页面操作指导、`Guide.jsx` 帮助指南对应章节；每个大版本（版本号前两位变化，或一次迭代新增多项功能）刷新帮助指南的“本版本新增”章节与新手指引 `TOUR_STEPS`（新菜单 / 新页面要有对应步骤）。

## 已确定的产品规则

- 解析出的 Markdown 只保留文字，不插入图片。
- 添加目录 / 整机目录后只扫描目录结构（`startTask(id, { scanOnly: true })`），不自动解析，由用户在“📂 目录”中选择文件夹或点“开始解析”；任务排队依次执行。侧栏按钮默认“＋ 添加整机目录”（已有整机任务时直接打开），下拉菜单保留“添加目录”。
- 名称、修改时间、大小、作者一致的文件不重复解析，但要提示用户并允许选择重新解析；解析历史完整保留（删除任务不删历史）。
- 只保留一份运行日志 `ppt-agent.log`。
- 功能按钮归一：添加目录、扫描本机所有文档只放在左侧；能在侧栏切换的子视图不在右侧重复放页签。
- 所有列表都用 `src/components/DataTable.jsx`（唯一例外：目录树 `DirTree.jsx` 是树形表，自带排序 / 筛选 / 多选 / 分批渲染）（每列排序、显示/隐藏列、Excel 式筛选、关键字搜索、可多选），新列表不要手写 `<table>`；日期 / 数字列给出 `type`，标签类多值列给出 `filterList`；列表要铺满到窗口底部。
- 界面上不要随意加说明性提示文字（页头副标题、tooltip 长句等），说明放到帮助指南（`Guide.jsx`）；新增功能同步更新帮助指南与新手指引。
- **单机版，不联网**（v3.2）：`electron/core/offline.js` 的 `OFFLINE_ONLY = true` 时 `llm.client` / `embedder` 一律返回空，依赖大模型的功能给出 `OFFLINE_MSG`；设置“PPT_Agent”页签下方的“其他大模型功能 / 语义向量”锁定；`getConfig()` 带 `offlineOnly` 给界面判断。网络用途只有：用户主动发送的反馈邮件，以及 PPT_Agent（v3.11，用户在设置中打开“允许连接大模型接口”后才会向其设置的接口地址发请求，默认关闭）。新功能不得引入其他联网调用。
- 外部大模型只走设置中的接口（PPT_Agent `config.pptAgent.llm`；旧的“Agent 接口”`config.llm` 单机版锁定），不得在代码中内置任何 API Key。PPT_Agent 的 API Key 由 `ppt_agent/llm.js` 用 Electron `safeStorage` 加密保存为 `apiKeyEnc`，`getConfig()` 只给界面 `hasApiKey`，`setConfig` 拒绝界面传入的 apiKey / apiKeyEnc（只能经 `pptAgentSetConfig`）。
- 所有解析过程不改动原文件（只读打开，输出写数据目录）；唯一例外是用户手动点击“写入 PPT 备注”（二次确认 + 先备份）。
- 侧栏结构：解析任务（蓝；任务列表，点击任务后在该任务下方展开“任务详情”菜单，`SCOPED` 视图只显示所选任务 `curTask`：任务概览、解析过程；再次点击收起；不再有任务内的资料库浏览，统一用“所有资料库”）→ 总览分析（绿；智能搜索、总览分析、所有资料库、全部任务与历史、相似分组）→ 智能模块（紫；导出篮、黑白底互转、智能生成、智能合成〔建设中〕、PPT_Agent〔插件〕）→ 维护（橙；回收站、运行日志、通知管理）→ 帮助指南 → 用户信息（预留）/ ⚙ 设置。新视图要先决定属于“任务范围”还是“全部”，任务范围的接口都接受 `taskId`。
- 凡是显示统计数字的地方（统计卡片、计数、分类 / 扩展名标签）都要能点击下钻：用 `DrillDialog.jsx` 的 `StatCards` / `app.drill({ key, title, rows | load, show })` 打开文件清单，不要只显示数字。
- 从列表进入详情再返回，要回到原来的界面与条目：`DataTable` 按 `sessionKey`（默认 `id`）在会话内记住筛选、关键字、滚动位置与上次点击的行（`row-last` 高亮）；视图内的页签 / 筛选用模块级缓存保存；`app.openFile` 会记住当前视图与打开的下钻清单，返回时恢复。
- 涉及文件的列表都提供“📂 在资源管理器中显示”（`api.showItem`）。
- 提示一律用 `app.toast(msg, kind, { label, link, cat })`：每条都会记入“维护 → 通知管理”（localStorage `ppta.notices`，最多 500 条）；`link` 必须可序列化（`{type:'task'|'tmonitor'|'search'|'open'|'reveal'|'view', ...}`），由 `App.openLink` 解析跳转，不要在通知里放函数。
- 大批量（v3.3）：任务事件只带 `getTaskLite`（不含 `scan_list`）；`main.js` 把 task / progress 事件合并为 `taskBatch` / `progressBatch` 每 120ms 推送（slide 事件每批每任务最多 12 条）；全库计算（`afterLibraryChange`、`computeGroups/computePairs/computeLinks`）是 async 并用 `yieldy.ticker()` 分片让出主进程，新的全库循环也必须分片；常见标签 / 页标题 / 大分组要设上限，不要写两两比较。渲染端进度只保留最近 `FILES_KEEP` 条。
- 子任务（v3.5；v3.12 起 `split.enabled` 默认关闭，旧配置升级时关闭一次，设置中不再显示——改为在目录树中按文件夹选择分析，下面的机制只为兼容已拆分的旧任务保留）：总任务扫描后文件数超过 `config.split.size`（默认 1000，`split.enabled`）时，`splitIntoChildren` 用 `splitter.splitFiles` 按盘符 → 文件夹拆分（子任务 = `tasks` 行，`parent_id / part_no / part_label`，`roots = { files, sub: true }`），插到队列最前面；调度用 `runningSet`（`service.running` 只是取第一个的 getter）+ `pump/runOne`：子任务最多同时执行 `config.split.parallel` 个（默认 3），普通任务 / 总任务扫描独占；`office.serial` 让 PowerPoint / Word / LibreOffice 调用逐个执行，`inflightFp` 让并行时相同指纹的文件等前一个解析完再判断重复；总任务的解析动态只跟随 `leadSub`（最早开始的子任务）；总任务的状态 / 数量由 `refreshParent` 汇总（子任务 `emitTask` 时触发），`startTask(总任务, { resume })` = 继续未完成的子任务，`pauseTask / cancelTask(总任务)` 作用于全部子任务，删除总任务连带子任务；`store.taskFiles / history(taskId)` 包含全部子任务（`familyIds`）；子任务日志标记 `[任务#子][总任务#总]`，进度事件同时转发给总任务（`subscanned / subdone`）；只有最后一个子任务结束时全库重算。界面：`app.tasks` 只含总任务、`app.allTasks` 含子任务；侧栏 / 任务队列 / 搜索范围只列总任务；任务概览“🧩 子任务”页签（`SubtaskPanel.jsx`，数字下钻用 `subtaskFiles`，含“待处理”）；打开子任务用 `app.go({ type: 'task', id: 子任务 })`（侧栏仍选中总任务，`view.sub`）；子任务完成不单独弹提示。
- 插件（v3.5，v3.7 改为脚本调用，v3.11 并入 PPT_Agent）：智能模块“🤖 PPT_Agent”（`PluginView.jsx`，侧栏 `plugin: true` 显示“插件”标记，路由仍为 `plugins`）；`electron/core/ppt_agent/harness.js`（`plugins/summary.js` 只是转引）管理队列、读取文档内容、保存结果（`summaries/<id>_<名>_总结.md` + `doc_summaries` 表，`searchQuery` 返回 `summaries` → 搜索“🧠 文档总结”页签）。生成方式是设置中的脚本（`config.plugins.summary`：`script / args（{input} {output} {file} {md}）/ timeout / auto / enabled`，设置页 `PluginSettings.jsx`），`scriptRunner.js` 在子进程中执行（.js 用 `process.execPath` + `ELECTRON_RUN_AS_NODE`），“生效”必须先 `pluginCheck` 试运行通过（`pluginEnable`）；`runTask` 每解析完一个文档调用 `summary.onParsed`（任何错误都不影响解析）；失败经 `notice` 事件 → 界面 `pluginNotice` 通知（10 秒限流），连续 3 次失败自动暂停；`pause()` 立即结束运行中的脚本、文档放回队列。示例脚本 `plugins/summary-example.js`（electron-builder `extraResources` 打包到 resources/plugins）。（v3.11 删除了 `summaryWorker.js`，所有引擎都经 `service.ai.run`）测试用 `PPTA_FAKE_LLM=1`。
- AI 调用模块（v3.9，v3.11 加入 PPT_Agent 大模型接口）：所有“调用 AI”都走 `electron/core/ai.js` 的 `AiGateway`（`service.ai`）：`mode()` = `config.pptAgent.engine`（llm | script，未设置时有生效的脚本用 script），`engine()`：llm → `ai.llm`（`ppt_agent/llm.js`，需 API Key + `allowNetwork`）、script → AI 调用脚本，都不可用时 fake（`PPTA_FAKE_LLM=1`）；提示词在 `PROMPTS`（summarize 可用 `pptAgent.prompt` 覆盖）；`can(task)`（summarize；expandQuery 需 `useForSearch`；generate 需 `useForGenerate`）；`run(task, input)` 写输入 JSON（含 `task`）给脚本；便捷方法 `summarize / expandQuery / generateKeywords` 失败返回 null、不影响调用方。智能总结插件、`SearchEngine.analyze`（查询扩展，界面“AI 扩展查询”）、`smartCandidates`（AI 关键词）都用它，新功能不要再直接调 `llm.client` 或 `scriptRunner`。`getConfig().ai` 给界面判断。
- 智能总结关联（v3.9）：总结文件头部 front matter（原文件、解析 Markdown、文档编号、生成方式、生成时间），`doc_summaries.src_path / src_md`；`searchQuery` 给 `files[].summary / summaryHit`，只有总结命中的文档以 tier 4“总结命中”加入；`fileDetail().summary`。
- 乱码兼容（v3.9）：`electron/core/textfix.js`——`zip.text()` 用 `decodeXml`（BOM / XML 声明编码 / GB18030 回退）；`processFile` 显示名 `fixMojibake(rawName)`（指纹仍用 `rawName` 与原始作者），解析结果入库前 `fixParsed`；`repairTextEncoding()` 存量修复（启动后一次，`config.textFixRev`；设置“🔤 修复乱码文字”）。`fixMojibake` 只在可疑字符占比 ≥ 30%、原文无中文时尝试，合法 UTF-8 候选优先，新增候选编码要补单元测试（含西文不误改）。
- 预计剩余时间（v3.10）：解析任务的 `eta` 由 `service.etaFor(task)` 在每次 `emitTask` 时计算（最近约 90 秒的完成数 / 时间，数据不足 5 秒时 `remainingMs = null`），总任务用汇总数量；`tasks()` 带 `etaLast`。AI 智能总结的 `state().eta` 用本批最近 10 个已结束文档的平均耗时。界面统一用 `src/components/Eta.jsx` 的 `EtaLine`（两次更新之间每秒走动；`compact` 只显示“剩余约 …”）。新的长时间批处理也要给出 eta。
- PPT_Agent（v3.11）：大模型接入层直接拷贝 DeepSeek Harness（MIT）的代码到 `vendor/dsh-llm/upstream`（原样，不改；来源 commit 与文件清单见 `vendor/dsh-llm/SOURCE.md`），适配器在 `vendor/dsh-llm/src`（shims / retry / client），`npm run build:dsh` 用 rolldown 编译为 `electron/core/ppt_agent/dsh-llm.cjs`（提交生成物；改 vendor 后必须重新生成并跑测试）。`ppt_agent/llm.js`（`PptAgentLlm`，`service.ai.llm`）：`status()` 判断可用、`chat()` 调用（`AbortSignal.timeout` + 暂停用的 signal）、`test()` 测试连接；main 注入 `box = safeStorage`、`fetchImpl = net.fetch`（系统代理）。harness（`ppt_agent/harness.js`，`service.summary`）：流水线 `pipeline = { source, reader, model, sinks }`，`use(stage, plugin)` 替换；`tick()` 每秒检查，到 `pptAgent.pollSec` 时 `poll()` 从 `pptAgent.scopes`（任务 / 子任务 id，子任务按 `id OR parent_id`）取已解析、没有总结的文档入队（本次运行失败过的不自动重试）；`onParsed` 对脚本沿用“自动总结”，对大模型接口需 `pptAgent.auto`（默认关）。服务接口 `pptAgentTasks / pptAgentRun({ taskIds, force, poll }) / pptAgentSetScopes / pptAgentSetConfig / pptAgentTest / pptAgentTaskFiles`。界面：`PluginView.jsx`（选择任务 / 进度 / 已生成的总结）、设置页签 `ai` 显示为“PPT_Agent”（`PptAgentSettings.jsx` + `PluginSettings.jsx`，`focus: 'agent' | 'plugin'`）；打开联网要二次确认。单元测试用本地 http 模拟 DeepSeek Messages SSE。
- 文件夹特征值与目录树（v3.12）：`runTask` 扫描后 `statSizes(..., mtimes)` → `dirSignatures`（每个文件夹直接包含的文档“文件名|大小|修改秒”排序后 MD5）→ `store.saveDirScan`（表 `dir_stats(task_id, dir, files, bytes, mtime, sig, sig_done, ...)`）；非强制运行时 `sig === sig_done` 的文件夹用 `filesByPaths` + `linkSkippedBulk` 一次记为跳过（消息“文件夹未变化（特征值相同），跳过”）；运行完成后 `markDirsDone`（本轮有失败文件的文件夹不记）。运行选项 `startTask(id, { dirs, force, scanOnly })` 存 `runOpts`：`dirs` 只扫描所选文件夹，`scan_list` 与 `dir_stats` 只替换这部分（`saveDirScan` 的 `replaceUnder`），原文件已删除的检查也只在所选范围；`force` 传给 `processFile`；`scanOnly` 扫描 + 统计后直接结束（状态保持 / 回到待解析）。`taskTree(id)`（原始层级、只列含文档的文件夹及其上级，子树合计 files / bytes / mtime / parsed / dirs{same,changed,new}）、`dirFiles(id, dir)` 下钻。界面 `DirTree.jsx`（任务概览默认页签“📂 目录”）：同级排序（名称 / 文档数 / 大小 / 最近修改）、筛选、只看有变化、勾选父文件夹即包含子文件夹、每次渲染 400 行滚动追加、展开与排序会话内记住。
- 内存（v3.11；v3.12 内存上限默认 16GB、按全部进程合计：main 注入 `service.totalMemMB`，超过时 `releaseMemory` 清检索 / 分组缓存与 `mediaSrc`、通知界面 `releaseMemory` 清日志与已结束任务的解析动态；`db.q` 语句缓存上限 400、`mediaSrc` 上限 5000、渲染端解析动态最多保留 20 个任务）：从数据库读出的向量一律是 `vectors.sparsify` 后的 `SparseVec`（只能用 `cosine` / `toDense` / `mean`，不要按下标读写；写回数据库时 `toBlob` 自动转稠密）；PDF 用 `pdf.js openRange`（`PDFDataRangeTransport` 按需读文件），图片型 PDF（平均每页 > 1.5MB）不做 `getOperatorList` 底色判断；`imageLuminance` 超过 12MB 的图片跳过；zip 中压缩存放的大部件超过 48MB 不整体解压。新功能不要把全部页面 / 文件的大字段同时读进内存。
- 资源与优先级（v3.11）：`config.perf`（`yieldOnActivity / idleOnly / idleSec / memLimitMB / bigFileMB`，设置 → 常规 → 资源与优先级 `PerfSettings.jsx`，`focus: 'perf'`）；渲染进程 pointerdown / keydown / wheel 节流 1 秒调 `api.userActivity` → `service.userActivity`；`runTask` 每个文件前 `resourceGate`（空闲期 / 让路只保留 `inLoop` 中最早的任务 / 内存上限先 `forceGc` 最多等 30 秒 / 大文件锁 `acquireBig`）；`yieldy.setBusyProbe` 让 `ticker` 在用户操作时放慢；`procs.track` 把外部程序设为低优先级；`memInfo`（`app.getAppMetrics`）列进程与内存，超过 1.5GB 每分钟写日志。新的长时间循环也要用 `ticker` / 经过 `resourceGate`。
- 存储空间与文件大小（v3.11）：`runTask` 扫描后 `statSizes`（并发 64）得到每个文件大小，`tasks.bytes_total / bytes_done`（总任务由 `refreshParent` 汇总；拆分时子任务的大小放在 `roots.sizes`）；第一次执行的总任务 `checkSpace` → `estimateSpace`（比例 = 数据目录大小 / 已解析原文件大小，资料库小时 3% / 有截图 25%）→ 日志、`notice`、`spaceEstimate` 事件（main 写 `bootstrap.estimates[数据目录].tasks`）；启动选择数据目录与“目录与数据”显示 `free`（`statfsSync`）与 `space`；`resourceGate` 中剩余 < 512MB、`ENOSPC` / `SQLITE_FULL` → `pauseForSpace`（暂停总任务 + 通知，可从断点继续）。service 的 `notice` 事件由 main 转为 `appNotice`。
- 任务文件清单（v3.11）：`store.taskFiles / taskFilesLite(Async) / taskFileIdList` 只取本轮（未删除的子任务，且 `tf.at >= 该任务 run_started`）；不要再把历次增量扫描的记录全部发给界面，完整记录用 `history()`（解析历史）。
- 检索缓存（v3.11）：`SearchEngine.loadAsync(onLoad)` 按读取行数报告“准备检索索引”进度、并发调用共用一次读取（`loading`），`invalidate()` 后 `prewarm()` 3 秒后后台预读，服务启动 5 秒后也预读。
- “打开原文件”前面一律有“📂”（`api.showItem`，在资源管理器中定位）；新增打开文件的按钮也要成对出现，📂 在前。
- 外部进程（v3.10.1）：启动外部程序一律经 `electron/core/procs.js` 登记（`office.run` / `scriptRunner` 已接入，新代码不要直接 `execFile`），超时 / 暂停用 `procs.killTree`（Windows `taskkill /T /F`，其他系统结束进程组，spawn 时 `detached: !isWin`），`main.js` 在 `will-quit` / `window-all-closed` / `process 'exit'` 调 `procs.killAll()`。Word / PowerPoint 自动化脚本一律用 `office.js` 的 `comScript`：记录 New-Object 前后新出现的进程并输出 `PPTA_PID:<pid>:<启动时间>`，结束时本次启动的实例一律 Quit（不要再写“已有 Word 在运行就不 Quit”——Word 每次自动化都新开进程，会越积越多）、释放 COM、等待退出后输出 `PPTA_DONE`；`ps()` 没收到 `PPTA_DONE` 时按 PID + 启动时间结束；正在使用的 Office 进程记在 `userData/office-procs.json`，启动时 `cleanupStale`；只结束 PID 与启动时间都一致的进程，不结束用户自己打开的 Word / PowerPoint。遗留进程检查与结束：`findOrphans / killOrphans`（设置 → 常规 → 后台 Word / PowerPoint 进程，`OfficeProcs.jsx`，`focus: 'procs'`），启动后发现会发 `appNotice`。LibreOffice 一律用 `sofficeArgs`（临时用户配置）。测试用 `PPTA_FAKE_OFFICE_PROCS=1` 模拟遗留进程。
- 提示栏（v3.9.1）：信息类提示栏一律用 `src/components/Notice.jsx`（`<Notice id=...>`），`id` 里带上任务 / 文件 / 数量 / 状态，用户点 ✕ 后记在 `ppta.dismissed`，内容变化时自动重新显示；设置 → 界面与快捷键可恢复全部；只反映当前筛选等不需要关闭的条不传 `id`。
- 界面不假死（v3.8）：`DataTable` 只渲染前 `PAGE`（300）行，滚动到底部追加（`dt-more`），排序用 `Intl.Collator`；其他长列表用 `src/useIncremental.js`（`items / sentinel`，`keepIndex` 保证选中项可见）；给界面的文件列表用精简行（`store.liteRow / listLibraryAsync / taskFilesLiteAsync`，不带 terms / vec / emb / fingerprint，meta 只留 slideSize），统计类接口只返回数量或 id，不要再把上万条完整记录发给界面；同一页面不要重复请求同一份大数据（资料库总览用 `overview({ tasksOnly: true })` + 已加载的文件）；`api.js` 记录进行中的调用，`BusyHint.jsx` 在超过 0.3 秒时显示“正在加载…”（对话框 / 轮询 / 检索不计入，`NO_BUSY`）。新增接口若要处理上万条数据，必须分页读取或用 `ticker` 让出主进程。剖析脚本思路：复制 10k 文档的数据目录，逐个点击页面，记录主进程事件循环延迟、界面帧间隔与日志中的“接口 X 耗时”。
- 智能搜索进度（v3.8）：`SearchEngine.search` 用 `progressReporter` 按 7 个阶段（load / analyze / meta / fts / vector / score / rank）推送进度并用 `ticker` 让出主进程；`searchQuery(q, { progressId })` 发 `searchProgress` 事件；`SearchProgress.jsx` 显示进度条与当前阶段，“详细进度”默认折叠（`ppta.searchProgOpen`）。新增检索步骤要加到 `STAGES`。
- 任务状态单一来源：暂停写入状态 `pausing`（“暂停中…”），各视图读 `app.tasks`（由 `taskBatch` 实时合并），“是否在执行”用 `isActive(t)`；暂停 / 取消后不做全库重算，置 `libraryDirty`，空闲时 `kickLibraryRefresh` 后台补算，完成后推 `library` 事件刷新界面。
- 不复制原文件（v3.3）：页面图片只记录 `<mediaKey>/<部件路径用 ~ 分隔>`，`ppta://media` 由 `service.readMedia` 从原文件（旧版 .ppt 为转换后的 .pptx）读取；不要再把原文件内容写入数据目录；需要临时文件时优先硬链接 / 符号链接。
- 开始 / 继续解析统一调用 `app.startParse(id, 'start'|'resume'|'watch')`，调用后自动跳到该任务的“解析动态”。
- 解析动态按事件序号（`seq`）播放，不按数组下标；每页停留时间从显示时起算，积压时缩短停留时间平滑追赶，不整段跳过。
- 智能搜索每次检索都记录到 `search_history`（结果存 `cache/search/<id>.json`，保留最近 300 条）；搜索队列在 `src/searchQueue.js`（前端依次执行，可排序 / 暂停）。智能生成等内部调用传 `record: false`。
- 双击任何带 `data-sid` 的页面预览都会打开逐页浏览（App 级监听）；浏览 / 对比窗口内双击保留为最大化；不需要该行为的区域加 `data-noopen`。
- DataTable 列宽可拖动（表头右边缘，双击按内容适配，记住在 `ppta.table.<id>.widths`）；不要再给列表单元格写死 `max-width`。
- 浏览类快捷键的 `isTyping` 不把勾选框 / 单选框算作输入。
- 文件详情（`SlideWorkspace`）在不进入逐页浏览时也支持键盘翻页（keymap 的翻页与切换文件动作都用于翻页）和滚轮翻页；滚轮翻页 / Ctrl + 滚轮缩放由 `config.wheel` 控制，`ZoomStage` 的 `onWheelPage` 负责翻页。
- 反馈：接收地址只在主进程 `service.js` 中（`FEEDBACK_TO`），不得传给界面或写进前端代码；发件邮箱 `config.mail` 由用户在设置中配置，未配置 / 失败时存 `dataDir/feedback/*.json`，配置后或启动后自动补发（`electron/core/mailer.js` 为无依赖 SMTP 客户端）。
- 启动选择数据目录（v3.4）：在创建资料库服务之前，`main.js` 的 `chooseDataDirAtStartup` 打开单独的启动窗口（同一渲染包，`#boot-datadir` → `DataDirDialog.jsx` 的 `StartupDataDir`，只用 `ppta.boot(...)` 通道：info / selectDir / choose / quit），选定后直接用该目录启动，不要再做“切换后重启”的应用内弹窗；启动窗口关闭时 `booting` 防止 `window-all-closed` 退出。`bootstrap.json` 中 `dataDirHistory`（最多 10 个）、`askDataDir`（记住选择 = false）、`skipAskOnce`（主动切换目录后的重启不再询问）、`askReset34`（旧版本的记住选择升级后重置一次）；使用环境变量 `PPTA_DATA_DIR` 时不询问（测试用 `PPTA_ASK_DIR=1` 强制询问，选中的目录只用于本次）。
- 帮助指南三个页签（`HELP_TABS`：使用说明 / 版本记录 / 需求文档）：版本记录与需求文档由 `src/docs.js` 直接读取打包进程序的 `docs/需求文档.md`（`?raw`），所以每次迭代刷新需求文档即同步更新帮助；变更记录表格按版本从小到大追加新行，每行用顶层“；”分隔条目（界面上逐条显示）；另存 Word / Markdown 走 `saveRequirementsDoc`（electron-builder `files` 已包含 `docs/需求文档.*`）。
- 侧栏左下角按钮（帮助、设置）以及“解析任务”标题右侧的“🗂 全部”（全部任务与历史）再次点击收起并还原打开前的界面（帮助指南不论从哪里打开都记在 `helpPrev`，不要固定回到智能搜索）；帮助按钮打开后只显示“收起”，两种状态宽度一致。
- 侧栏任务列表超过 3 个任务时默认只占 3 个的高度、可滚动，底部拖动条调整高度（`ppta.sbTasksH`，上限窗口高度一半）。
- 侧栏顶部冻结：`.sb-top`（logo、帮助、添加目录、解析任务模块）`position: sticky`，其余模块在下方滚动，底部 `.sb-foot` 固定；新加的侧栏模块放在 `.sb-top` 之后。
- 需要“返回”的跳转用 `app.go({ ..., back: true })`：App 记住当前视图放进 `view.back`，目标页（任务概览、解析过程）左上角显示“← 返回”；从侧栏直接打开时没有 `back`。
- 设置分 5 个页签（`SettingsView` 的 `SET_TABS`：常规 / 界面与快捷键 / 反馈邮件 / PPT_Agent（key `ai`）/ 目录与数据），`focus`（watch / keys / mail / agent / plugin / perf / procs / datadir）经 `FOCUS_TAB` 定位到页签；新设置项放进对应页签。
- 讲解词小语种只在“设置 → 常规 → 讲解词小语种”配置（`config.minorLangs`，`focus: 'langs'`），讲解词模块直接列出这些语言，不要再在应用中放语言下拉。
- 智能搜索首页推荐词与输入框示例由 `searchSuggestions` 从已导入文档的标签生成，不要写死示例词。
- 智能搜索范围用 `taskIds`（多选的已执行任务，空 = 所有资料库），前端记在 `ppta.searchScope`；`search_history.task_ids` 记录每次范围。
- 转换规则设置的新增规则：已保存的自定义规则与“新增规则”草稿区分开；草稿区默认一条样例（`sampleRule`），`untouchedSample` 判断与样例完全相同的行，保存（“💾 保存新增的规则” / “保存规则”）时一律忽略；保存新增后草稿区重置为一条样例。
- 黑白底互转每次转换写入 `convert_history`（含完整结果 JSON），转换页“🕘 转换历史”可重新查看。
- 导出篮支持多选（Shift 连选），勾选时只导出所选页面。
- 完善讲解词（总览分析）：应用内修改讲解词只写数据库（`notes_user`、`notes_kb`），默认不改原 PPT；`notesChanges` 列出待写回项，`writeBackNotesBatch` 按文件分组一次写回（`noteswriter.writeNotesBatch`，修正讲解词整段替换、译文追加【语言】段落，每个文件先备份），写回记录在 `notes_writeback`。
- 智能生成分三步：挑选页面 → “📄 生成新 PPT”（`generateDeck` 不带统一底色）→ 生成结果逐页拆解，抬头“统一为白底 / 统一为黑底”调用 `unifyDeck(path, ids, theme)`（沿用源页面底色，`convertFile` 加 `themes`）另存 `*_白底 / *_黑底`；原 PPT 与生成的 PPT 都不改；每组相似页面可多选。
- 任务删除只在“全部任务与历史 → 任务队列”：多选（解析中 / 排队中不可选）→ “🗑 删除所选” → 确认 → `deleteTasks(ids, true)`；侧栏任务不放删除按钮。
- 智能合成（`MergeView.jsx`，建设中）：上传多个文件（`selectFiles(title, 'docs')`）或从资料库选整个文件；分析 / 合并 / 冲突选择未实现，按钮保持禁用并标“建设中”。
- 列表项很多的页面（如相似分组）用“左侧列表 + 右侧详情”的主从布局，不要在一个滚动区里堆叠多个 DataTable。
- 智能搜索：后端返回全部命中页（不截断），文件的“命中 N 页”= 该文件在结果中的页数；选中文件时页签数字只统计该文件，再次单击取消；结果过多时前端分批显示。
- 浏览窗口从搜索结果打开时传 `results`（结果页顺序），左右键只在搜索结果之间翻页；点击相关推荐后必须显示醒目的“↩ 返回原来的页面”。
- 每个页面（含逐页浏览 / 对比窗口）左下角固定有“?”帮助图标，不放在标题栏、不挤占关闭等按钮；侧栏标题旁的“❓ 帮助”按钮保持原位（`src/components/PageHelp.jsx` 的 `PAGES`），新增页面或功能时同步补充该页的操作指导；不要在界面上常驻快捷键提示条。
- 3.0 设计系统在 `src/styles.css` 末尾“v3.0 设计系统”段：颜色只用变量（`--bg/--bg2/--bg3/--bg4/--line/--fg*/--accent*/--ok/--warn/--danger`、模块色 `--m-detail/--m-over/--m-smart/--m-maint`、阴影 `--sh-sm/md/lg`、圆角 `--radius/--radius-lg`），浅色 / 深色两套都要定义；新组件不要写死颜色，主操作用 `.btn.primary`，次要用 `.btn`，弱操作用 `.btn.ghost`。
- 黑白底互转“按文件 / 文件夹”：`listPptx` 递归列出 PPT，`convertFile(src, { direction, outMode: 'suffix'|'dir', outDir })` 只读原文件、另存（同名加序号），记入 `convert_history`。
- PDF（v3.1）：`electron/core/pdf.js` 用 pdf.js 标准版（`pdfjs-dist/build/pdf.mjs`，legacy 版在 Electron 的 Node 中会崩溃）只读提取每页文字与底色；不生成截图，界面用 `ppta://src/<文件 id>` 直接渲染原 PDF（主进程只提供 `kind = 'pdf'` 的资料库文件），cMap / 标准字体经 `ppta://pdfjs/...` 提供；主进程解析时由 `LocalDataFactory`（`BinaryDataFactory`）按本地路径读取 cMap / 字体，不要再把文件系统路径当作 `cMapUrl`（Windows 反斜杠路径会被 pdf.js 拒绝，v3.3.1）。PDF 与 Word 一样属于“文档”：搜索单独 `slides.pdf` 页签、关联归入“相关文档内容”、不导出为 PPT 页 / 不参与黑白底互转与相似分组 / 讲解词不写回。新增文档类型时按 `DOC_TYPES`、`KIND_LABEL / KIND_ICON`、搜索分组、`relations.isDoc` 依次补齐。
- SmartScreen（v3.4.1）：启动时 `winmark.clearDownloadMark` 删除程序自身 exe（便携版为 `PORTABLE_EXECUTABLE_FILE`）的 `:Zone.Identifier` 下载标记，避免未签名 exe 每次启动都被 SmartScreen 询问；只处理程序自己的 exe，结果写运行日志。
- 通用 UI / 列表规范见仓库根目录 `.claude/skills/desktop-app-ui-conventions/SKILL.md`。
- 文档删除一律先进回收站（可还原），彻底删除需二次确认，且只删除移入回收站的那份文件。
- 任务状态颜色：解析中浅蓝底黑字、已完成绿色、待解析浅橙底。
- 保存对话框按用途记住上次目录（`saveFile(name, kind, key)`）。
- 浏览类窗口的键盘操作一律走 `src/keymap.js`（动作 → 按键，用户可在设置中自定义），不要在组件里写死按键；新增动作要加到 `ACTIONS` 与 `DEFAULT_KEYMAP`。
- 定时监测更新只对 `tasks.watch = 1` 且已手动完成过首次解析的任务做增量扫描；增量扫描中原文件已删除的文档以“仅移出资料库”方式进回收站；在回收站中的文档重新扫描时不自动加回。
- 页面标签与页面关联在 `electron/core/relations.js`，由 `afterLibraryChange → computeRelations` 全量重算（表 `slide_links`）；是否关联 Word / PDF 取决于设置中是否同时选择 PPT 与 Word 或 PDF。浏览类视图右侧都带 `RelatedRail` 推荐栏，点击推荐在当前位置替换查看并可返回。
- 对比窗口最多 4 个文档（`COMPARE_MAX`），文档多选的列表旁同时提供“⧉ 对比查看”。
- 测试数据在 `test-ppts/`，由 `scripts/make_test_ppts.py` 生成；不要无谓地整体重生成已提交的大文件（会重复提交 25MB 视频）。

## 结构

- `electron/core/`：解析（pptx.js、docx.js、pdf.js）、检索（search.js）、导出（exporter.js）、黑白底互转（converter.js）、服务编排（service.js）、数据库（db.js）。
- `src/`：React 界面；`SlideViewer.jsx` 是逐页浏览（弹窗与搜索页签共用）；`CompareView.jsx` 是多文档对比窗口；`keymap.js` 是快捷键定义。
- 单元测试 `tests/core.test.js` 用 Electron 内置 Node 运行（需要 node:sqlite）。
