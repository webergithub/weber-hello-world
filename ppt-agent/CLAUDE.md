# PPT智能体（ppt-agent）开发约定

## 每次迭代必须做的事（用户要求）

每次根据用户指令迭代功能后：

1. 刷新需求文档 `docs/需求文档.md`：版本号、变更记录、需求清单（新需求加编号与状态），并用 `pandoc docs/需求文档.md -o docs/需求文档.docx` 生成 Word 版。
2. `package.json` 的 `version` 递增，与需求文档版本一致。
3. 运行 `npm test`，并用 Playwright 驱动界面验证改动（`xvfb-run`）。
4. 打包 Windows exe：`npx vite build && npx electron-builder --win portable --x64 --publish never`，把产物复制到 `download/`（删除旧版本 exe，保持只有一个）。同步更新 README 中的下载文件名。
5. 提交并推送到 GitHub，然后在对话中发送 exe 与需求文档给用户下载。

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
- 侧栏结构：解析任务（选择任务）→ 任务详情（蓝；`SCOPED` 视图只显示所选任务 `curTask`：任务概览、解析过程；不再有任务内的资料库浏览，统一用“所有资料库”）→ 总览分析（绿；智能搜索、总览分析、所有资料库、全部任务与历史、相似分组）→ 智能模块（紫；导出篮、黑白底互转、智能生成）→ 维护（橙；回收站、运行日志）→ 帮助指南 → 用户信息（预留）/ ⚙ 设置。新视图要先决定属于“任务范围”还是“全部”，任务范围的接口都接受 `taskId`。
- 凡是显示统计数字的地方（统计卡片、计数、分类 / 扩展名标签）都要能点击下钻：用 `DrillDialog.jsx` 的 `StatCards` / `app.drill({ key, title, rows | load, show })` 打开文件清单，不要只显示数字。
- 从列表进入详情再返回，要回到原来的界面与条目：`DataTable` 按 `sessionKey`（默认 `id`）在会话内记住筛选、关键字、滚动位置与上次点击的行（`row-last` 高亮）；视图内的页签 / 筛选用模块级缓存保存；`app.openFile` 会记住当前视图与打开的下钻清单，返回时恢复。
- 涉及文件的列表都提供“📂 在资源管理器中显示”（`api.showItem`）。
- 浏览窗口从搜索结果打开时传 `results`（结果页顺序），左右键只在搜索结果之间翻页；点击相关推荐后必须显示醒目的“↩ 返回原来的页面”。
- 每个页面右上角都有“?”帮助图标（`src/components/PageHelp.jsx` 的 `PAGES`），新增页面或功能时同步补充该页的操作指导；不要在界面上常驻快捷键提示条。
- 通用 UI / 列表规范见仓库根目录 `.claude/skills/desktop-app-ui-conventions/SKILL.md`。
- 文档删除一律先进回收站（可还原），彻底删除需二次确认，且只删除移入回收站的那份文件。
- 任务状态颜色：解析中浅蓝底黑字、已完成绿色、待解析浅橙底。
- 保存对话框按用途记住上次目录（`saveFile(name, kind, key)`）。
- 浏览类窗口的键盘操作一律走 `src/keymap.js`（动作 → 按键，用户可在设置中自定义），不要在组件里写死按键；新增动作要加到 `ACTIONS` 与 `DEFAULT_KEYMAP`。
- 定时监测更新只对 `tasks.watch = 1` 且已手动完成过首次解析的任务做增量扫描；增量扫描中原文件已删除的文档以“仅移出资料库”方式进回收站；在回收站中的文档重新扫描时不自动加回。
- 页面标签与页面关联在 `electron/core/relations.js`，由 `afterLibraryChange → computeRelations` 全量重算（表 `slide_links`）；是否关联 Word 取决于设置中是否同时选择 PPT 与 Word。浏览类视图右侧都带 `RelatedRail` 推荐栏，点击推荐在当前位置替换查看并可返回。
- 对比窗口最多 4 个文档（`COMPARE_MAX`），文档多选的列表旁同时提供“⧉ 对比查看”。
- 测试数据在 `test-ppts/`，由 `scripts/make_test_ppts.py` 生成；不要无谓地整体重生成已提交的大文件（会重复提交 25MB 视频）。

## 结构

- `electron/core/`：解析（pptx.js、docx.js）、检索（search.js）、导出（exporter.js）、黑白底互转（converter.js）、服务编排（service.js）、数据库（db.js）。
- `src/`：React 界面；`SlideViewer.jsx` 是逐页浏览（弹窗与搜索页签共用）；`CompareView.jsx` 是多文档对比窗口；`keymap.js` 是快捷键定义。
- 单元测试 `tests/core.test.js` 用 Electron 内置 Node 运行（需要 node:sqlite）。
