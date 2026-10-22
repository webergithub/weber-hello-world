# PPT智能体（ppt-agent）开发约定

## 每次迭代必须做的事（用户要求）

每次根据用户指令迭代功能后：

1. 刷新需求文档 `docs/需求文档.md`：版本号、变更记录、需求清单（新需求加编号与状态），并用 `pandoc docs/需求文档.md -o docs/需求文档.docx` 生成 Word 版。
2. `package.json` 的 `version` 递增，与需求文档版本一致。
3. 运行 `npm test`，并用 Playwright 驱动界面验证改动（`xvfb-run`）。
4. 打包 Windows exe：`npx vite build && npx electron-builder --win portable --x64 --publish never`，把产物复制到 `download/`（删除旧版本 exe，保持只有一个）。同步更新 README 中的下载文件名。
5. 提交并推送到 GitHub，然后在对话中发送 exe 与需求文档给用户下载。
6. 新功能同步更新帮助：`PageHelp.jsx` 的页面操作指导、`Guide.jsx` 帮助指南对应章节；每个大版本（版本号前两位变化，或一次迭代新增多项功能）刷新帮助指南的“本版本新增”章节与新手指引 `TOUR_STEPS`（新菜单 / 新页面要有对应步骤）。

## 已确定的产品规则

- 解析出的 Markdown 只保留文字，不插入图片。
- 添加目录后不自动解析，由用户手动开始；任务排队依次执行。
- 名称、修改时间、大小、作者一致的文件不重复解析，但要提示用户并允许选择重新解析；解析历史完整保留（删除任务不删历史）。
- 只保留一份运行日志 `ppt-agent.log`。
- 功能按钮归一：添加目录、扫描本机所有文档只放在左侧；能在侧栏切换的子视图不在右侧重复放页签。
- 所有列表都用 `src/components/DataTable.jsx`（每列排序、显示/隐藏列、Excel 式筛选、关键字搜索、可多选），新列表不要手写 `<table>`；日期 / 数字列给出 `type`，标签类多值列给出 `filterList`；列表要铺满到窗口底部。
- 界面上不要随意加说明性提示文字（页头副标题、tooltip 长句等），说明放到帮助指南（`Guide.jsx`）；新增功能同步更新帮助指南与新手指引。
- 外部大模型只走设置中的“Agent 接口”（`config.llm`），不得在代码中内置任何 API Key。
- 所有解析过程不改动原文件（只读打开，输出写数据目录）；唯一例外是用户手动点击“写入 PPT 备注”（二次确认 + 先备份）。
- 侧栏结构：解析任务（蓝；任务列表，点击任务后在该任务下方展开“任务详情”菜单，`SCOPED` 视图只显示所选任务 `curTask`：任务概览、解析过程；再次点击收起；不再有任务内的资料库浏览，统一用“所有资料库”）→ 总览分析（绿；智能搜索、总览分析、所有资料库、全部任务与历史、相似分组）→ 智能模块（紫；导出篮、黑白底互转、智能生成）→ 维护（橙；回收站、运行日志、通知管理）→ 帮助指南 → 用户信息（预留）/ ⚙ 设置。新视图要先决定属于“任务范围”还是“全部”，任务范围的接口都接受 `taskId`。
- 凡是显示统计数字的地方（统计卡片、计数、分类 / 扩展名标签）都要能点击下钻：用 `DrillDialog.jsx` 的 `StatCards` / `app.drill({ key, title, rows | load, show })` 打开文件清单，不要只显示数字。
- 从列表进入详情再返回，要回到原来的界面与条目：`DataTable` 按 `sessionKey`（默认 `id`）在会话内记住筛选、关键字、滚动位置与上次点击的行（`row-last` 高亮）；视图内的页签 / 筛选用模块级缓存保存；`app.openFile` 会记住当前视图与打开的下钻清单，返回时恢复。
- 涉及文件的列表都提供“📂 在资源管理器中显示”（`api.showItem`）。
- 提示一律用 `app.toast(msg, kind, { label, link, cat })`：每条都会记入“维护 → 通知管理”（localStorage `ppta.notices`，最多 500 条）；`link` 必须可序列化（`{type:'task'|'tmonitor'|'search'|'open'|'reveal'|'view', ...}`），由 `App.openLink` 解析跳转，不要在通知里放函数。
- 开始 / 继续解析统一调用 `app.startParse(id, 'start'|'resume'|'watch')`，调用后自动跳到该任务的“解析动态”。
- 解析动态按事件序号（`seq`）播放，不按数组下标；每页停留时间从显示时起算，积压时缩短停留时间平滑追赶，不整段跳过。
- 智能搜索每次检索都记录到 `search_history`（结果存 `cache/search/<id>.json`，保留最近 300 条）；搜索队列在 `src/searchQueue.js`（前端依次执行，可排序 / 暂停）。智能生成等内部调用传 `record: false`。
- 双击任何带 `data-sid` 的页面预览都会打开逐页浏览（App 级监听）；浏览 / 对比窗口内双击保留为最大化；不需要该行为的区域加 `data-noopen`。
- DataTable 列宽可拖动（表头右边缘，双击按内容适配，记住在 `ppta.table.<id>.widths`）；不要再给列表单元格写死 `max-width`。
- 浏览类快捷键的 `isTyping` 不把勾选框 / 单选框算作输入。
- 文件详情（`SlideWorkspace`）在不进入逐页浏览时也支持键盘翻页（keymap 的翻页与切换文件动作都用于翻页）和滚轮翻页；滚轮翻页 / Ctrl + 滚轮缩放由 `config.wheel` 控制，`ZoomStage` 的 `onWheelPage` 负责翻页。
- 反馈：接收地址只在主进程 `service.js` 中（`FEEDBACK_TO`），不得传给界面或写进前端代码；发件邮箱 `config.mail` 由用户在设置中配置，未配置 / 失败时存 `dataDir/feedback/*.json`，配置后或启动后自动补发（`electron/core/mailer.js` 为无依赖 SMTP 客户端）。
- 启动选择数据目录：`bootstrap.json` 中 `dataDirHistory`（最多 10 个）、`askDataDir`（记住选择 = false）、`skipAskOnce`（主动切换目录后的重启不再询问）；使用环境变量 `PPTA_DATA_DIR` 时不询问（测试用 `PPTA_ASK_DIR=1` 强制询问）。
- 侧栏左下角按钮（帮助、设置）以及“解析任务”标题右侧的“🗂 全部”（全部任务与历史）再次点击收起并还原打开前的界面；帮助按钮打开后只显示“收起”，两种状态宽度一致。
- 侧栏任务列表超过 3 个任务时默认只占 3 个的高度、可滚动，底部拖动条调整高度（`ppta.sbTasksH`）。
- 需要“返回”的跳转用 `app.go({ ..., back: true })`：App 记住当前视图放进 `view.back`，目标页（任务概览、解析过程）左上角显示“← 返回”；从侧栏直接打开时没有 `back`。
- 智能搜索范围用 `taskIds`（多选的已执行任务，空 = 所有资料库），前端记在 `ppta.searchScope`；`search_history.task_ids` 记录每次范围。
- 转换规则设置的新增规则：已保存的自定义规则与“新增规则”草稿区分开；草稿区默认一条样例（`sampleRule`），`untouchedSample` 判断与样例完全相同的行，保存（“💾 保存新增的规则” / “保存规则”）时一律忽略；保存新增后草稿区重置为一条样例。
- 黑白底互转每次转换写入 `convert_history`（含完整结果 JSON），转换页“🕘 转换历史”可重新查看。
- 导出篮支持多选（Shift 连选），勾选时只导出所选页面。
- 完善讲解词（总览分析）：应用内修改讲解词只写数据库（`notes_user`、`notes_kb`），默认不改原 PPT；`notesChanges` 列出待写回项，`writeBackNotesBatch` 按文件分组一次写回（`noteswriter.writeNotesBatch`，修正讲解词整段替换、译文追加【语言】段落，每个文件先备份），写回记录在 `notes_writeback`。
- 智能生成统一底色：先用所选页面导出新 PPT，再调用 `convertSlides` 另存 `*_白底 / *_黑底`，原 PPT 与第一份输出都不改；每组相似页面可多选。
- 列表项很多的页面（如相似分组）用“左侧列表 + 右侧详情”的主从布局，不要在一个滚动区里堆叠多个 DataTable。
- 智能搜索：后端返回全部命中页（不截断），文件的“命中 N 页”= 该文件在结果中的页数；选中文件时页签数字只统计该文件，再次单击取消；结果过多时前端分批显示。
- 浏览窗口从搜索结果打开时传 `results`（结果页顺序），左右键只在搜索结果之间翻页；点击相关推荐后必须显示醒目的“↩ 返回原来的页面”。
- 每个页面（含逐页浏览 / 对比窗口）左下角固定有“?”帮助图标，不放在标题栏、不挤占关闭等按钮；侧栏标题旁的“❓ 帮助”按钮保持原位（`src/components/PageHelp.jsx` 的 `PAGES`），新增页面或功能时同步补充该页的操作指导；不要在界面上常驻快捷键提示条。
- 3.0 设计系统在 `src/styles.css` 末尾“v3.0 设计系统”段：颜色只用变量（`--bg/--bg2/--bg3/--bg4/--line/--fg*/--accent*/--ok/--warn/--danger`、模块色 `--m-detail/--m-over/--m-smart/--m-maint`、阴影 `--sh-sm/md/lg`、圆角 `--radius/--radius-lg`），浅色 / 深色两套都要定义；新组件不要写死颜色，主操作用 `.btn.primary`，次要用 `.btn`，弱操作用 `.btn.ghost`。
- 黑白底互转“按文件 / 文件夹”：`listPptx` 递归列出 PPT，`convertFile(src, { direction, outMode: 'suffix'|'dir', outDir })` 只读原文件、另存（同名加序号），记入 `convert_history`。
- PDF（v3.1）：`electron/core/pdf.js` 用 pdf.js 标准版（`pdfjs-dist/build/pdf.mjs`，legacy 版在 Electron 的 Node 中会崩溃）只读提取每页文字与底色；不生成截图，界面用 `ppta://src/<文件 id>` 直接渲染原 PDF（主进程只提供 `kind = 'pdf'` 的资料库文件），cMap / 标准字体经 `ppta://pdfjs/...` 提供。PDF 与 Word 一样属于“文档”：搜索单独 `slides.pdf` 页签、关联归入“相关文档内容”、不导出为 PPT 页 / 不参与黑白底互转与相似分组 / 讲解词不写回。新增文档类型时按 `DOC_TYPES`、`KIND_LABEL / KIND_ICON`、搜索分组、`relations.isDoc` 依次补齐。
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
