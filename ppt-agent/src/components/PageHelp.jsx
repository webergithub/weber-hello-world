import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { useKeymap, viewerHintItems } from '../keymap';

// 每个页面的操作指导：点击页面左下角的“?”图标展开（侧栏标题旁的“帮助”按钮除外）；help 为帮助指南中对应章节
const PAGES = {
  search: {
    title: '智能搜索', help: 'search',
    items: [
      '输入关键词或一句话后按回车，中英文混合均可，例如“机航 turnaround”。',
      '“🎯 范围”选择检索范围：所有资料库，或在已执行的任务中多选（全选 / 仅当前任务 / 清空），选择会记住。',
      '左侧“相关 PPT”按文件名 → 标签 → 内容命中排序；单击文件只看它的搜索结果（白底 / 黑底 / Word 页签数字随之变化），再次单击取消选择回到全部结果；勾选 2–4 个文件可并排对比。',
      '右侧按白底 / 黑底 / Word 页签展示命中的页面与讲解词；有另一底色版本时可点“⇄”切换。',
      '勾选页面后可“加入导出篮”或直接“导出新 PPT”；“⛶ 逐页浏览”页签可用键盘逐页翻看。',
      '点击页面卡片打开浏览窗口：左右键（或两侧 ‹ ›、底部缩略条）按结果顺序在搜索结果之间翻页。',
      '“＋ 加入队列”把搜索排进搜索队列依次执行（排队中的可 ↑ ↓ 调整顺序、移除、暂停）；“🗂 搜索任务与历史”中可查看任意一次搜索的结果、重新搜索或删除历史；首页显示最近搜索。',
    ],
  },
  task: {
    title: '任务概览', help: 'tasks',
    items: [
      '右上角：▶ 开始解析 / ⏸ 暂停 / ↻ 重新扫描 / 增量扫描；“📡 监测更新”开启后每天定时增量扫描。',
      '页面浏览：左侧文件、中间页面列表（可多选、Shift 连选），右侧原始页、讲解词与 Markdown。',
      '文件统计：本任务每个文件的解析结果，列表可排序、筛选、多选对比或移到回收站；点击任意统计数字打开对应的文件清单。',
      '有已解析过的重复文件时，顶部会提示，可选择重新解析。',
    ],
  },
  tmonitor: {
    title: '解析过程', help: 'tasks',
    items: [
      '解析动态：实时显示正在解析的文件与页面（扫描线动画）、提取的文字、生成的 Markdown 和标签。',
      '随时“⏸ 暂停”，之后“▶ 继续”会从断点接着解析（暂停时正在解析的文件会重新解析）。',
      '解析历史：本任务每个文件每次的处理记录；正在解析的文件显示在最上方并自动定位，勾选“跟随”会随文件切换自动定位。',
      '“📂 在资源管理器中显示”打开所选（或最近点击）文件所在的文件夹，每行的 📂 同样可用；解析动态中当前文件旁也有该按钮。',
      '点击文件名查看详情，“← 返回”回到原来的列表并高亮刚才查看的条目；点击顶部计数可按结果筛选。',
      '在历史中勾选记录后可“重新解析所选”。',
    ],
  },
  monitor: {
    title: '全部任务与历史', help: 'tasks',
    items: [
      '任务队列：所有任务按顺序依次解析，可调整顺序、“▶ 全部开始”、暂停与继续；点击卡片上的“解析 / 已解析过 / 重复 / 失败”数字或右侧统计卡片打开对应的文件清单。',
      '解析动态：选择任意任务查看实时解析过程。',
      '解析历史：所有任务的处理记录，可筛选结果、搜索路径、勾选后重新解析。',
    ],
  },
  library: {
    title: '所有资料库', help: 'library',
    items: [
      '页签：总览（统计与文档列表）、PPT 总览库（逐页浏览全部文档）、按文件夹 / 文件名称 / 标签分类；总览中点击任意统计数字或主题分类打开对应的文件清单。',
      '列表：点击列标题排序，▾ 按列筛选（文本 / 数字 / 日期 / 按值），拖动列标题右侧边缘调整列宽（双击按内容适配），“☰ 列设置”显示或隐藏列、重置列宽，勾选后可对比或移到回收站。',
      'PPT 总览库左侧文件名一栏可拖动右侧分隔条调整宽度；双击任意 PPT 原版页面直接进入逐页浏览。',
      '点击文件名进入详情：不进入逐页浏览也能直接翻页——↑ ↓ ← → / PgUp PgDn 翻页、Home / End 首末页、在原始页上滚动滚轮翻页；Ctrl + 滚轮无级缩放，“⤢ 适配窗口”恢复。',
      '讲解词：原讲解词 / 生成讲解词 / 修正讲解词三个页签，可切换中文、English 或小语种。',
      '右侧“🔗 相关推荐”列出相似页面，点击即在当前位置替换查看，标题旁的“↩ 返回原来的页面”回到原页，多次跳转后可“⤒ 回到最初”。',
    ],
  },
  groups: {
    title: '相似分组', help: 'compare',
    items: [
      '内容相近的 PPT（如黑底 / 白底版本、不同版本副本）归为一组：左侧是分组列表（可按分组名、文件数、总大小等排序与筛选），右侧显示所选分组的全部文件。',
      '“⧉ 对比本组”把组内文档并排打开，一起翻页对比。',
      '勾选文档后可对比查看、在资源管理器中显示或移到回收站；可跨分组勾选。',
    ],
  },
  analytics: {
    title: '总览分析', help: 'analytics',
    items: [
      '点击顶部任意统计卡片，打开对应的文件清单。',
      '近期访问 / 修改：选择一天 / 一周 / 一个月，以及打开或修改。',
      '长期未打开：选择半年 / 1 年 / 2 年 / 3 年。',
      '读写统计：点击任意柱形或条形，打开对应的文件清单。',
      '清单中每行可“打开文件”或“在资源管理器中显示”。',
      '右上角设置统计刷新频率（每次打开 / 每天 / 每周 / 仅手动），或立即刷新。',
    ],
  },
  recycle: {
    title: '回收站', help: 'analytics',
    items: [
      '移到回收站的文档在这里，可“还原”回资料库（原文件一并移入的会还原到原位置）。',
      '“彻底删除”需二次确认，只删除移入回收站的那份文件；“仅从资料库移除”的文档只清理解析数据。',
    ],
  },
  convert: {
    title: 'PPT 黑白底互转', help: 'convert',
    items: [
      '标题下方的“当前转换规则”提示黑转白、白转黑与 logo / 背景图规则，“查看 / 修改”打开规则设置。',
      '先把页面加入导出篮，再在这里把需要的页面加入转换队列。',
      '为每页选择“自动 / 转白底 / 转黑底 / 保持”。',
      '标题旁的“⚙ 转换规则设置”：分黑转白 / 白转黑两个页签，可修改基础规则并添加自定义规则（元素 + 原颜色 → 转换后颜色），附转换前后预览。',
      '点击开始转换并选择保存位置（默认文件名带“_白底 / _黑底”）；转换后显示逐页校验结果，可“逐页浏览转换结果”。',
      '“🕘 转换历史”保存每一次转换（时间、输出文件、页数、黑→白 / 白→黑、来源文件、校验），可重新查看结果、逐页浏览、打开文件或位置、删除记录。',
      '“🗂 按文件 / 文件夹”：选择一个或多个 PPT 文件或文件夹（含子文件夹），选择转换方向（自动互换 / 统一白底 / 统一黑底）与输出位置（原目录加后缀 / 统一新目录），点击“开始批量转换”；原文件不会被修改。',
    ],
  },
  generate: {
    title: '智能生成（建设中）', help: 'start',
    items: [
      '输入主题或版式要求，点击“智能匹配”。',
      '纵向每行是一种内容，横向是相似页面；点击页面勾选 / 取消，每行可多选（相似度高的页面也可以同时加入），“本组全选 / 只留代表页”快速调整，按行顺序生成 PPT。',
      '底色选“统一为白底 / 黑底”时，先用所选页面生成新 PPT，再调用黑白底互转另存一份 *_白底 / *_黑底 文件；原 PPT 不会被修改。',
      '右上角的相似阈值控制分组粗细。',
    ],
  },
  basket: {
    title: '导出篮', help: 'export',
    items: [
      '在搜索结果、页面列表或逐页浏览（空格键）中加入的页面都在这里，可来自不同文件。',
      '用 ↑ ↓ 调整顺序、✕ 移除。',
      '勾选页面（Shift 连选、全选）后“导出为新 PPT / 导出 Markdown”只导出所选页面；不勾选时导出全部。可“移除所选”。',
      '“导出为新 PPT”保留原版式、母版与讲解词；也可导出 Markdown。',
    ],
  },
  notesreview: {
    title: '完善讲解词', help: 'notes',
    items: [
      '应用默认不修改原 PPT：在页面详情中修改的“修正讲解词”和保存的译文都只存在应用里，并集中列在这里。',
      '左侧列表按类型、文件、页、修改时间等可排序与筛选；点击一行，右侧对比 PPT 中的原讲解词与修改后的内容（删除为红色、新增为绿色）。',
      '勾选 1 条或多条（Shift 连选），点击“✍ 批量写入 PPT 备注”：修正讲解词替换该页备注，译文以“【语言】”段落追加；每个文件写入前自动备份。',
      '“写回记录”列出每次写回的内容与备份文件位置。Word 文档与旧版 .ppt 不支持写回。',
    ],
  },
  notices: {
    title: '通知管理', help: 'analytics',
    items: ['应用中的全部通知（解析任务完成 / 失败、搜索完成、导出完成、错误提示等）都保存在这里，按时间、类型、级别可排序与筛选。', '点击通知内容或“查看任务 / 查看搜索结果 / 打开文件”跳转到对应界面；打开本页时未读通知加粗显示并全部标为已读。', '可勾选删除或清空通知。'],
  },
  logs: {
    title: '运行日志', help: 'settings',
    items: ['工具只保留一份日志文件，记录解析、检索、导出、转换等全部工作过程，可按级别 / 关键字筛选、搜索与复制。', '“⇩ 导出日志”保存为 .log 文件：有筛选条件时导出当前显示的日志，未筛选时导出完整日志文件；任务详情中的运行日志默认只导出本任务。'],
  },
  settings: {
    title: '设置', help: 'settings',
    items: [
      '解析文档类型、Agent 接口、页面截图等修改后点击右上角“保存设置”。',
      '主题、快捷键、定时监测更新修改后立即生效。',
      '快捷键：点击“＋ 添加按键”后直接按下新组合，可选预设或恢复默认；下方可开关“滚轮翻页”和“Ctrl + 滚轮缩放”。',
      '数据保存目录：可迁移或切换目录，勾选“启动时询问”后每次打开程序先选择目录（可选历史目录），使用过的目录可直接切换。',
      '反馈邮件发送设置：配置发件邮箱（SMTP，授权码）后，“💬 意见反馈”会在后台发送；未配置时反馈先保存在本机，配置后自动补发。',
      '再次点击左下角 ⚙ 收起设置，回到打开设置前的界面。',
    ],
  },
  help: { title: '帮助指南', help: 'start', items: ['左侧目录跳转到各功能的详细说明；可重新播放新手指引或显示启动简介。'] },
  viewer: {
    title: '逐页浏览', help: 'viewer', keys: 'viewer',
    items: ['原始页、讲解词、Markdown 三个模块可拖动换位、调整大小；右侧“🔗 相关推荐”点击即替换查看。', '在页面上滚动鼠标滚轮翻页；页面可无级缩放：Ctrl + 滚轮或右下角缩放条，放大后拖动查看，“⤢ 适配窗口”恢复（滚轮行为可在设置中关闭）。'],
  },
  viewerResults: {
    title: '搜索结果浏览', help: 'search', keys: 'results',
    items: ['从智能搜索结果打开时窗口自动最大化；左右键（或两侧 ‹ ›、底部缩略条）在搜索结果之间翻页，顺序与结果页一致，可跨文件。', '顶部“按搜索结果翻页 / 按文件页面翻页”切换两种翻页方式，选择会记住；按文件页面翻页时与普通逐页浏览相同。', '页面可无级缩放：Ctrl + 滚轮或右下角缩放条，“⤢ 适配窗口”恢复。'],
  },
  compare: {
    title: '对比窗口', help: 'compare', keys: 'compare',
    items: ['每个窗格有独立的翻页按钮；打开“一起翻页”时同步翻动，单独翻某个窗格可跳过一页后继续一起翻。', '每个窗格标题旁的“同步翻页”勾选框：只有勾选的窗格（可以是 1 个或多个）参与一起翻页。'],
  },
};
PAGES.alllib = PAGES.library;
PAGES.file = PAGES.library;

/** 帮助图标：点击展开当前页面的操作指导（含当前快捷键）；onBeforeNav：跳转到帮助 / 设置前调用（如关闭弹窗） */
export default function PageHelp({ page, onBeforeNav, className = '' }) {
  const app = useApp();
  const keys = useKeymap();
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const pop = useRef(null);
  const [pos, setPos] = useState(null);
  const info = PAGES[page];
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = pop.current ? pop.current.offsetWidth : 380, h = pop.current ? pop.current.offsetHeight : 300;
    // 图标固定在左下角：弹窗与图标左对齐、向上展开
    const left = r.left < window.innerWidth / 2 ? Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) : Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    setPos({ left, top });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (pop.current && !pop.current.contains(e.target) && btn.current && !btn.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpen(false); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true); };
  }, [open]);
  if (!info) return null;
  const go = (v) => { setOpen(false); if (onBeforeNav) onBeforeNav(); app.go(v); };
  const keyItems = info.keys ? viewerHintItems(keys.map, { compare: info.keys === 'compare', results: info.keys === 'results' }) : null;
  return (
    <>
      <button ref={btn} className={`page-help-btn ${open ? 'on' : ''} ${className}`} title="本页操作指导" onClick={() => setOpen(!open)}>?</button>
      {open && (
        <div ref={pop} className="page-help-pop" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
          <div className="php-head"><b>💡 {info.title} · 操作指导</b><div className="spacer" /><button className="icon-btn tiny" onClick={() => setOpen(false)}>✕</button></div>
          <ul className="php-list">{info.items.map((t) => <li key={t}>{t}</li>)}</ul>
          {keyItems && (
            <>
              <div className="php-title">⌨ 快捷键</div>
              <div className="php-keys">{keyItems.map(([k, d]) => <React.Fragment key={d}><span className="kbd">{k}</span><span>{d}</span></React.Fragment>)}</div>
            </>
          )}
          <div className="php-foot">
            <span className="link" onClick={() => go({ type: 'help', focus: info.help })}>📖 帮助指南中的详细说明</span>
            {keyItems && <span className="link" onClick={() => go({ type: 'settings', focus: 'keys' })}>⌨ 自定义快捷键</span>}
          </div>
        </div>
      )}
    </>
  );
}
