---
name: desktop-app-ui-conventions
description: UI and list (table) conventions for building desktop / web business apps (Electron, React, admin tools, document or data management apps) with a Chinese-speaking product owner. Use whenever building or changing an app's UI - lists/tables, navigation menus, search pages, dashboards/analytics, viewers, settings, onboarding/help, long-running tasks - so every new app gets these behaviors by default without being asked again.
---

# Desktop app UI conventions

These rules come from many rounds of product feedback. Apply them by default in every app; the owner should not have to ask again.

## 1. Lists and tables (every list in the app)

Build ONE shared table component and use it for every list. Never hand-write a one-off `<table>`.

Each table must support:
- **Sort by any column**: click header cycles ascending → descending → none; show ▲/▼ and "按“列名”升序" in the toolbar.
- **Show / hide columns**: a "☰ 列设置（visible/total）" menu with "全部显示" and "恢复默认"; less important columns hidden by default.
- **Excel-style filters on every column**: a ▾ button in each header opens a popover with sort buttons, a condition filter by type and a value checklist (search box, select all, counts per value, "（空白）"):
  - text: 包含 / 不包含 / 等于 / 不等于 / 开头是 / 结尾是 / 为空 / 不为空
  - number: = ≠ > ≥ < ≤ / 介于 / 最大的前 N 项 / 最小的前 N 项 / 为空 / 不为空
  - date: 今天 / 最近 7 天 / 30 天 / 一年 / 早于 / 晚于 / 介于
  - Infer the column type automatically, allow overriding it. Multi-value cells (tags) filter by any value.
- **Keyword search across the whole list** in the toolbar; show "x / total 条" while filtered, active filters as removable chips, a "✕ 清除筛选" button, and an empty state with "清除筛选".
- **Multi-select with checkboxes**: select all, Shift+click range, "已选 N" badge, and bulk actions next to the selection (export, compare, move to recycle bin, …).
- **Resizable columns**: drag the right edge of any header to resize (switch the table to fixed layout once resized), double-click to fit the content, "重置列宽" in the column menu; remember widths per table. Side panels with lists (e.g. a file-name column) get a draggable splitter, remembered too.
- **Remember per-table settings** (sort, hidden columns, widths) in local storage under a per-table id.
- **Many items → master / detail**: when a page would show many groups or sections each with its own list, use a list of groups on the left and the selected group's table filling the right; never stack several tables in one scroll area (they collapse).
- **Counts must match what is shown**: a per-item count ("命中 13 页") must equal what appears when that item is selected; never cap the underlying result set silently — page the rendering instead ("显示更多 / 全部显示"). Selecting an item to filter updates every dependent count (tab badges); clicking it again clears the filter.
- **Fill the available height**: the list stretches to the bottom of the window and scrolls inside; never stop half-way down the page.
- Row actions for files: "打开文件" (open with the default app) and "在资源管理器中显示" (reveal in Explorer / Finder). Every list or process view that shows files gets a toolbar "📂 在资源管理器中显示" for the selected / last-clicked file plus a per-row 📂.
- **Coming back restores the context**: when a row opens a detail page and the user clicks "← 返回", return to the same view, tab, filters, keyword and scroll position, and highlight the row they opened (e.g. pale gold background + accent bar) scrolled into view. Keep this per-list state in memory for the session (keyed by list id + scope); also reopen any drill-down list that was open.

## 2. Layout and visual quality

- **Search pages**: before searching, put the search box in the centre of the page (horizontally and vertically), large and rounded, with a title, example chips and a short stats line. After searching, move it to a compact top bar with a clear button.
- **Every statistic drills down**: anywhere a count is shown (stat cards, "N 条 · 新增 x" counts, per-item counters on cards, category / extension chips, progress "n / total"), clicking it opens the list of the underlying items in one shared drill-down dialog (sortable / filterable table, the counted column shown first and sorted, open / reveal / compare actions). Counts inside a list's own toolbar may filter that list in place instead.
- **Dashboards and analytics**: every number tile and every bar / column is clickable and **drills down to the underlying item list**, shown as a closable tab with a "← 返回". Charts: one axis, thin bars, value labels, hover tooltips. Let the user set the refresh frequency (每次打开 / 每天 / 每周 / 仅手动); show the "统计时间" and next refresh time.
- **Tabs visually attached** to the content below them.
- Detail views with several panels: panels can be resized by dragging, swapped by dragging their title bar, minimised to a bottom dock, layout toggles (上1下2 / 左1右2); remember sizes and layout.
- **Status colours**: in progress = light blue background + black text, done = green, waiting = light orange background. Make sure text stays readable on its colour.
- Support light / dark / follow-system themes with CSS variables.
- Never let buttons or tabs wrap one character per line: tabs and buttons `white-space: nowrap`, toolbars `flex-wrap: wrap`.
- Avoid explanatory sentences in headers and tooltips unless the owner asked for them. Keep the UI clean; put explanations in the help guide instead. When unsure, ask before adding hint text.

## 3. Navigation

- **Scope views to the selected item**: when the app manages several sources / projects / tasks, the sidebar lets the user pick one, and a "detail" section lists views that show ONLY that item's data (overview, process, files, search, groups). A separate "overview" section shows everything across all items (statistics, all-items library, all history, recycle bin). Never mix other items' data into the scoped views; search offers a toggle "当前任务 / 所有资料库".
- The scoped "detail" menu hangs directly under the selected item in the item list (expand on select, click again to collapse), not in a separate block far from it.
- Sidebar look: grouped sections with icon + title + count / current-scope chip, foldable; items as rounded pills with an accent bar when active; item cards with status dot, mini progress bar and hover actions; tools (basket, logs, settings, help, theme) pinned at the bottom.
- Collapsible left sidebar (icon-only mode); each sidebar section can be folded separately; remember both.
- **No duplicated buttons**: global actions (e.g. 添加目录, 扫描本机) live in one place only, normally the left sidebar. Sub-views that are switched from the sidebar do not get duplicate tabs on the right.
- Sidebar order: work items → item detail (scoped) → overview → smart / experimental modules → maintenance (recycle bin, logs) → bottom tools (basket, help). The very bottom row: user info on the left (placeholder until accounts exist), a ⚙ settings icon on the right; theme switching lives in settings.
- Closing the window offers "minimize to the system tray (右下角图标栏)" / "quit" (rememberable). In the tray: click restores, right-click menu has show window and quit. Allow only one running instance; launching again restores the window.
- Toggle buttons for pages like settings / help: a second click closes the page and restores the exact previous view.
- Feedback: a "💬 反馈" button sends in the background; never show the recipient address in the UI or ship it in front-end code, never embed mail credentials — the sending mailbox is configured in settings and feedback is queued locally until it can be sent.
- On startup, apps with a data directory let the user pick the current / a previously used / a new directory, with "remember, don't ask again" (re-enable in settings).
- Detail views support keyboard and mouse-wheel paging even without opening the full viewer; wheel paging and Ctrl+wheel zoom are user options in settings.
- AI-dependent features with no configured API key show a clear "去设置" prompt instead of silently falling back to a canned template; mark unfinished AI features "建设中".
- Features still being built are marked "建设中" (a small tag on the menu item or button).
- Clicking a running item jumps straight to its live detail view.

## 4. Viewers and keyboard

- Full-page viewers support maximise, fullscreen and keyboard paging: ← → previous / next page, ↑ ↓ previous / next file, Home / End, Space to select, Esc to restore.
- **All shortcuts are user-configurable** in settings (record a key, conflict warning, presets such as "↑ ↓ 翻页 · ← → 切换文件", reset). Shortcut hints in the UI are generated from the current key map; never hard-code keys in components.
- Allow side-by-side comparison of 2–4 items with linked paging plus per-pane controls.
- Page / image previews support stepless zoom: Ctrl + wheel around the cursor, a small zoom bar (－ / slider / ＋ / percentage / "⤢ 适配窗口"), drag to pan when zoomed, keys = / - / 0; keep the zoom level when paging.
- Rule editors (e.g. colour conversion) use one tab per direction, a before/after preview, a base-rule table "element · original · after · effect swatch", and a custom-rule list "element + original value (any / exact + tolerance) → result (value / keep / none)" with enable, reorder and delete; first matching custom rule wins.
- A "related items" side rail: clicking an item replaces the current view in place and shows a prominent "↩ 返回原来的页面" button (highlighted colour, Backspace too); after several jumps also offer "⤒ 回到最初".
- Double-clicking any page / item preview opens it in the full viewer directly; inside the viewer double-click toggles maximise.
- Comparison windows: each pane has a "同步翻页" checkbox so the user picks which 1..n panes page together.
- A viewer opened from a search result pages through the **search results** (same order as the result page, across files) with ← → only; hide file / page navigation, show "搜索结果 i / N" and a strip of the results.
- Settings that drive a page's behaviour (e.g. current conversion rules) are summarised in a small block directly under the page title, with a "查看 / 修改" link.

## 5. Long-running tasks

- Starting / resuming a job navigates straight to its live progress view.
- Live animations are driven by event sequence numbers, never by indexes into a capped buffer; each frame has a minimum dwell measured from when it was shown, and backlogs speed up gradually instead of skipping.
- **Notification center**: every toast is also stored (time, category, level, message, serializable jump target) in a "通知管理" page under maintenance, with an unread badge; clicking a notification jumps to the related screen (finished task → task detail, finished search → its results).
- **Every run is history**: any user-triggered job that produces a result (search, conversion, export…) is recorded with its full result so it can be reopened later from a "历史" list.
- **Scope pickers are multi-select**: when an action can be limited to items (e.g. search within tasks), let the user tick any number of them (with 全选 / 仅当前 / 清空 = all), remember the choice, and record the scope in history.
- **Collections are multi-select**: baskets / queues support checkboxes with Shift range selection, and bulk actions (export, remove) apply to the selection (falling back to all when nothing is ticked).
- **Search history and queue**: every search is recorded with its result; users can queue several searches (reorder / remove / pause), and reopen any past search's result.

- Adding work never starts it automatically; the user presses start. Tasks queue and run one by one.
- Pause takes effect immediately, even mid-item; resume continues from the checkpoint, also after a crash or close.
- A live progress view with animation (current item, per-step progress) and a history list that shows the item currently being processed and auto-scrolls to it ("📍 定位", "跟随").
- Skip unchanged items (incremental processing), and offer scheduled incremental runs at a user-chosen time.

## 6. Safety and data

- **Edits stay in the app until confirmed**: changes the user makes to content that lives in their original files (e.g. speaker notes) are stored in the app only; a dedicated review page lists every pending change with a side-by-side diff, lets the user multi-select and write back in one batch (one backup per file, grouped writes), and keeps a write-back log with backup locations.
- Derived outputs never overwrite inputs: a "unified theme" export first writes the plain new file, then runs the converter into a separate *_白底 / *_黑底 file.

- Deletes go to an in-app recycle bin first (restore / permanently delete with a second confirmation).
- **Never modify the user's original files during processing** (open read-only, write outputs to the app's data folder). Writing back into an original file only happens on an explicit manual click, with a confirmation dialog and an automatic backup first. Destructive defaults (e.g. moving the original file) must not be preselected.
- Save dialogs remember the last folder per purpose; default file names are meaningful (source name + suffix).
- External AI / API keys live only in settings (provider presets such as DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI / Ollama, "测试连接"). Never embed keys in the app; without a key, fall back to an offline method.

## 7. Onboarding and help

- First launch: a short welcome page (what the app does, a 4–6 card overview, a one-line flow) with "下次打开时继续显示" unchecked by default.
- A guided tour of at most 8 steps: each step switches to the right view, spotlights the target area, and says "👉 做什么" and "👀 能看到什么", with 上一步 / 下一步 / 跳过 and keyboard ← → Esc.
- A "❓ 帮助指南" button at the bottom left opens the detailed help (table of contents, one section per feature, current shortcuts, replay tour).
- **Every page has a "?" help icon**, pinned to the **bottom-left corner** of the page and of each viewer / compare window, never in the title bar where it crowds close buttons (the app-level help button next to the app title stays where it is). Clicking it opens a popover with that page's operation guide (what you can do, step by step), the current keyboard shortcuts for viewers, and links to the matching help-guide section and to shortcut settings. Do not keep permanent shortcut hint bars on screen; fold them into this icon. Esc closes the popover without closing the underlying window.

- Refresh help with every feature: the page "?" guides and the help-guide chapters; on every major version add a "本版本新增" chapter and extend the onboarding tour with a step for each new menu / page.

## 8. Every iteration

- Keep a requirements document (.md + .docx) up to date: version, change log, requirement IDs with status.
- Bump the version, run the tests, drive the UI with an automated browser and look at screenshots before delivering.
- Build the installable package and deliver it together with the updated requirements document.
