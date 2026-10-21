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
- 所有列表都用 `src/components/DataTable.jsx`（每列排序、显示/隐藏列、可多选），新列表不要手写 `<table>`。
- 文档删除一律先进回收站（可还原），彻底删除需二次确认，且只删除移入回收站的那份文件。
- 任务状态颜色：解析中浅蓝底黑字、已完成绿色、待解析浅橙底。
- 保存对话框按用途记住上次目录（`saveFile(name, kind, key)`）。
- 测试数据在 `test-ppts/`，由 `scripts/make_test_ppts.py` 生成；不要无谓地整体重生成已提交的大文件（会重复提交 25MB 视频）。

## 结构

- `electron/core/`：解析（pptx.js、docx.js）、检索（search.js）、导出（exporter.js）、黑白底互转（converter.js）、服务编排（service.js）、数据库（db.js）。
- `src/`：React 界面；`SlideViewer.jsx` 是逐页浏览（弹窗与搜索页签共用）。
- 单元测试 `tests/core.test.js` 用 Electron 内置 Node 运行（需要 node:sqlite）。
