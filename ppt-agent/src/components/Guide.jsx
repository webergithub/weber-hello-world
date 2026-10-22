import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { useKeymap, keysLabel } from '../keymap';

// ================= 新手指引（每个大版本随功能更新） =================
// 每步：切换到对应视图 → 高亮目标区域 → 说明“做什么”和“能看到什么”
export const TOUR_STEPS = [
  {
    title: '添加要解析的目录', view: { type: 'search' }, target: '[data-tour="add"]',
    todo: '点击左上角“＋ 添加目录”，选择存放 PPT / Word / PDF 的文件夹；下拉 ▾ 可选择“添加所有本地文档”扫描整台电脑（可开启每日定时增量扫描）。',
    see: '左侧“解析任务”区出现一个“待解析”（浅橙色）的任务。点击任务即选中它，任务下方展开该任务的菜单（任务概览、解析过程），只显示这个任务的内容；再次点击收起。添加后不会自动开始，由你决定何时解析。',
  },
  {
    title: '开始解析，观看解析动态', view: { type: 'monitor', tab: 'live' }, target: '[data-tour="tasks"]', fallback: '[data-tour="nav-monitor"]',
    todo: '点击任务右侧的 ▶ 开始解析（或在“解析任务 → 任务队列”中点击“全部开始”）。多个任务会排队依次执行，可随时 ⏸ 暂停、之后从断点继续。',
    see: '“解析动态”实时显示：第几个文件、页面上移动的扫描线、逐行提取的文字、生成的 Markdown、逐个弹出的标签；重复的文件会提示是否重新解析。',
  },
  {
    title: '查看全部任务与历史', view: { type: 'monitor', tab: 'queue' }, target: '[data-tour="all-tasks"]', fallback: '[data-tour="tasks"]',
    todo: '点击“📂 解析任务”标题右侧的“🗂 全部”，在右侧查看全部任务的队列、解析动态与解析历史；再次点击收起并回到原来的界面。任务多于 3 个时，左侧任务列表可滚动，拖动列表底部的拖动条调整高度。',
    see: '点击某个任务的“查看结果”进入任务概览，左上角“← 返回”回到全部任务与历史，并选中刚才查看的任务。',
  },
  {
    title: '在资料库查看解析结果', view: { type: 'alllib' }, lib: 'overview', target: '.lib-tabs',
    todo: '“总览分析 → 所有资料库”查看解析过的文档（可按任务筛选）。用页签切换：总览、PPT 总览库、按文件夹 / 文件名 / 标签分类；点击任意统计数字打开对应的文件清单。',
    see: '每个文档的页数、黑白底、主题分类、20 个标签、作者等；点开文档可逐页查看原始页面、讲解词（备注）与解析出的 Markdown。',
  },
  {
    title: '逐页浏览与相关推荐', view: { type: 'alllib' }, lib: 'gallery', target: '.gallery-main', fallback: '.lib-tabs',
    todo: '在“PPT 总览库”中用键盘浏览：← → 翻页，↑ ↓ 切换文件，Enter 最大化（按键可在设置中自定义）。右侧“🔗 相关推荐”中点击推荐页即可替换查看，退格键返回。',
    see: '一页一屏的完整页面、讲解词与 MD 三个可拖动调整的模块；推荐栏列出本页标签、相似 PPT 页面（同时选择 Word 时还有相关 Word 内容）。',
  },
  {
    title: '智能搜索', view: { type: 'search' }, target: '.search-bar',
    todo: '在“总览分析 → 智能搜索”输入关键词或一句话，例如“机航 turnaround”或“如何缩短飞机过站时间”，中英文混合均可；“🎯 范围”可在已执行的任务中多选，“＋ 加入队列”可排队多个搜索，“🗂 搜索任务与历史”随时查看以前的结果；默认在所有资料库中检索，可切换为只搜当前任务。',
    see: '按“文件名 → 标签 → 内容”的顺序推荐相关 PPT 和页面，白底 / 黑底 / Word / PDF 分页签展示，命中词高亮，附讲解词；有另一底色版本时提示切换。',
  },
  {
    title: '把页面加入导出篮', view: { type: 'search' }, target: '[data-tour="nav-basket"]',
    todo: '在搜索结果、资料库页面列表或逐页浏览中勾选需要的页面（Shift 可连选），点击“加入导出篮”；逐页浏览中按空格即可加入 / 移出。',
    see: '左侧“导出篮”后面显示已收集的页数；页面可以来自不同文件、不同任务。',
  },
  {
    title: '调整顺序并导出新 PPT', view: { type: 'basket' }, target: '.main .view-head',
    todo: '在“智能模块 → 导出篮”中用 ↑ ↓ 调整页面顺序、移除不需要的页；可勾选部分页面（Shift 连选），然后点击“导出为新 PPT”（或导出 Markdown）只导出所选页面，选择保存位置。',
    see: '生成一个保留原始版式与讲解词的新 PPT（不同来源的母版会一并带上）；保存目录会被记住，完成后可直接打开。',
  },
  {
    title: 'PPT 黑白底互转', view: { type: 'convert' }, target: '.main .view-head',
    todo: '在“智能模块 → PPT 黑白底互转”中可按导出篮中的页面转换，也可切换到“按文件 / 文件夹”批量转换整份 PPT；按页面转换时从导出篮选择页面加入转换队列，为每页选择“自动 / 转白底 / 转黑底”；“⚙ 转换规则设置”可调整文字、表格、图形、Logo 的颜色规则。',
    see: '生成转换后的 PPT（默认文件名带“_白底 / _黑底”后缀），结果自动入库，可点“逐页浏览转换结果”对照查看；“🕘 转换历史”保存每一次转换，可随时重新查看。',
  },
  {
    title: '智能生成新 PPT', view: { type: 'generate' }, target: '.main .view-head',
    todo: '在“智能模块 → 智能生成”中描述主题或版式，点击“智能匹配”；每行是一种内容、横向是相似页面，点击页面勾选（每行可多选），选择“统一为白底 / 黑底”后生成。',
    see: '先用所选页面生成新 PPT，选择统一底色时再调用黑白底互转另存一份 *_白底 / *_黑底 文件；原 PPT 不会被修改。',
  },
  {
    title: '完善讲解词并写回 PPT', view: { type: 'notesreview' }, target: '[data-tour="nav-notesreview"]', fallback: '.main .view-head',
    todo: '在页面详情的讲解词模块中修改“修正讲解词”或保存译文后，到“总览分析 → ✍ 完善讲解词”查看全部修改，点击一条对比原文与修改后的内容，勾选后“批量写入 PPT 备注”。',
    see: '应用默认不改原 PPT；只有在这里确认写回时才写入对应页的备注，每个文件写入前自动备份，“写回记录”可查看每次写回与备份位置。',
  },
  {
    title: '通知、反馈与设置', view: { type: 'notices' }, target: '[data-tour="nav-notices"]', fallback: '.main .view-head',
    todo: '“维护 → 🔔 通知管理”汇总全部通知（任务完成、搜索完成、导出完成…），点击可跳转；左下角 💬 发送意见反馈，⚙ 打开设置（再次点击收起）。',
    see: '设置中可修改快捷键与鼠标滚轮（滚轮翻页、Ctrl + 滚轮缩放）、启动时是否询问数据目录、反馈发件邮箱等。',
  },
];

function useTargetRect(selector, fallback, tick) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    let n = 0, timer;
    const find = () => {
      const el = document.querySelector(selector) || (fallback && document.querySelector(fallback));
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        if (r.width && r.height) { setRect({ x: r.left, y: r.top, w: r.width, h: r.height }); return; }
      }
      if (n++ < 20) timer = setTimeout(find, 80); else setRect(null);
    };
    setRect(null);
    timer = setTimeout(find, 120);
    const onResize = () => find();
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [selector, fallback, tick]);
  return rect;
}

/** 新手指引：遮罩 + 高亮目标 + 说明卡片（上一步 / 下一步 / 跳过） */
export function Tour({ onClose, go, setLibMode, onHelp }) {
  const [i, setI] = useState(0);
  const step = TOUR_STEPS[i];
  const last = i === TOUR_STEPS.length - 1;
  useEffect(() => { if (step.lib) setLibMode(step.lib); go(step.view); }, [i]);
  const rect = useTargetRect(step.target, step.fallback, i);
  const card = useRef(null);
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { if (last) onClose(); else setI(i + 1); }
      else if (e.key === 'ArrowLeft') { if (i > 0) setI(i - 1); }
      else if (e.key === 'Escape') onClose();
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [i, last]);
  // 卡片放在高亮区域右侧，放不下时放下方 / 上方 / 居中
  const W = 380, H = card.current ? card.current.offsetHeight : 260, pad = 14;
  const vw = window.innerWidth, vh = window.innerHeight;
  let pos = { left: (vw - W) / 2, top: (vh - H) / 2 };
  if (rect) {
    if (rect.x + rect.w + pad + W < vw) pos = { left: rect.x + rect.w + pad, top: Math.min(Math.max(10, rect.y), vh - H - 10) };
    else if (rect.y + rect.h + pad + H < vh) pos = { left: Math.min(Math.max(10, rect.x), vw - W - 10), top: rect.y + rect.h + pad };
    else if (rect.y - pad - H > 0) pos = { left: Math.min(Math.max(10, rect.x), vw - W - 10), top: rect.y - pad - H };
  }
  return (
    <div className="tour">
      <div className="tour-block" onClick={(e) => e.stopPropagation()} />
      {rect ? <div className="tour-spot" style={{ left: rect.x - 6, top: rect.y - 6, width: rect.w + 12, height: rect.h + 12 }} /> : <div className="tour-dim" />}
      <div ref={card} className="tour-card" style={{ left: pos.left, top: pos.top, width: W }}>
        <div className="tc-head">
          <span className="tc-step">第 {i + 1} / {TOUR_STEPS.length} 步</span>
          <div className="spacer" />
          <button className="icon-btn tiny" title="退出指引（Esc）" onClick={onClose}>✕</button>
        </div>
        <div className="tc-title">{step.title}</div>
        <div className="tc-row"><b>👉 做什么</b><p>{step.todo}</p></div>
        <div className="tc-row"><b>👀 能看到什么</b><p>{step.see}</p></div>
        <div className="tc-dots">{TOUR_STEPS.map((s, k) => <span key={k} className={k === i ? 'on' : k < i ? 'done' : ''} title={s.title} onClick={() => setI(k)} />)}</div>
        <div className="tc-foot">
          <button className="btn small ghost" onClick={onClose}>跳过</button>
          <div className="spacer" />
          <button className="btn small" disabled={i === 0} onClick={() => setI(i - 1)}>← 上一步</button>
          {last
            ? <><button className="btn small" onClick={() => { onClose(); onHelp(); }}>查看帮助指南</button><button className="btn small primary" onClick={onClose}>完成 ✓</button></>
            : <button className="btn small primary" onClick={() => setI(i + 1)}>下一步 →</button>}
        </div>
      </div>
    </div>
  );
}

// ================= 启动简介 =================
const FEATURES = [
  ['📄', '逐页解析入库', 'PPT 每页转为 Markdown，保留讲解词（备注），Word 按章节、PDF 按页解析；视频只取字幕；本地数据库保存。'],
  ['🏷', '自动标签与关联', '每个文档 20 个标签、每页 8 个页面标签，相似页面 / 黑白底版本 / Word 与 PDF 内容自动关联推荐。'],
  ['🔍', '中英文智能搜索', '本地 RAG：文件名 → 标签 → 内容三层检索，白底 / 黑底分开推荐页面。'],
  ['🧺', '挑页导出新 PPT', '跨文件多选页面加入导出篮，调整顺序后一键导出新的 PPT 或 Markdown。'],
  ['🌓', '黑白底互转', '按可配置的规则把页面在白底与黑底之间转换，结果可逐页对照查看。'],
  ['⧉', '对比与分组', '相似 PPT 自动分组，2–4 个文档并排对比、一起翻页。'],
];

export function WelcomeDialog({ onClose }) {
  const app = useApp();
  const [again, setAgain] = useState(() => !!(app.config && app.config.welcome === 'always'));
  const close = (next) => onClose({ again, next });
  return (
    <div className="overlay welcome-overlay">
      <div className="modal welcome" onClick={(e) => e.stopPropagation()}>
        <div className="wl-hero">
          <div className="wl-logo">PPT<span>智能体</span></div>
          <div className="wl-sub">把电脑里的 PPT、Word 与 PDF 变成可搜索、可复用的本地知识库</div>
        </div>
        <div className="wl-grid">
          {FEATURES.map(([ic, t, d]) => <div key={t} className="wl-card"><div className="wl-ic">{ic}</div><div><b>{t}</b><p>{d}</p></div></div>)}
        </div>
        <div className="wl-flow">
          <span>① 添加目录</span><i>→</i><span>② 开始解析</span><i>→</i><span>③ 浏览 / 搜索</span><i>→</i><span>④ 挑页加入导出篮</span><i>→</i><span>⑤ 导出新 PPT / 黑白互转</span>
        </div>
        <p className="muted small wl-note">全部数据保存在本机，不上传；大模型与语义向量为可选项，未配置时完全离线可用。</p>
        <div className="wl-foot">
          <label className="chk"><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} /> 下次打开时继续显示此简介</label>
          <div className="spacer" />
          <button className="btn" onClick={() => close('help')}>📖 帮助指南</button>
          <button className="btn" onClick={() => close(null)}>直接开始使用</button>
          <button className="btn primary" onClick={() => close('tour')}>🧭 开始新手指引（{TOUR_STEPS.length} 步）</button>
        </div>
      </div>
    </div>
  );
}

// ================= 帮助指南（详细介绍） =================
export function HelpView({ onTour, onWelcome, focus }) {
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => { api.appVersion().then(setAppVersion).catch(() => {}); }, []);
  const app = useApp();
  const keys = useKeymap();
  const k = (a) => keysLabel(keys.map, a);
  const body = useRef(null);
  useEffect(() => { const el = focus && body.current && body.current.querySelector(`#help-${focus}`); if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('flash-sec'); setTimeout(() => el.classList.remove('flash-sec'), 1700); } }, [focus]);
  const SECTIONS = [
    ['whatsnew', `本版本新增（v${appVersion || ''}）`, <>
      <ul>
        <li><b>侧栏解析任务（3.1）</b>：任务超过 3 个时列表只占 3 个的高度、可滚动，底部拖动条可上下拖动调整高度（双击恢复）；标题右侧“🗂 全部”在右侧打开全部任务与历史，再次点击收起；从全部任务与历史查看某个任务后，左上角“← 返回”回到原来的页面。</li>
        <li><b>📕 支持 PDF 解析（3.1）</b>：在 PPT、Word 之外新增 PDF 文档类型（设置 → 解析文档类型，默认启用）。每页提取文字与标题、识别黑底 / 白底、生成 Markdown 与标签；页面直接用内置 pdf.js 只读渲染原文件；智能搜索新增“📕 PDF”页签；PDF 页面与 PPT 页面相互推荐。原 PDF 不会被修改。</li>
        <li><b>✍ 完善讲解词</b>（总览分析）：应用内修改过的讲解词与译文集中列出，对比原文后多选批量写回 PPT 备注（写入前自动备份，保留写回记录）。</li>
        <li><b>智能生成</b>：每组相似页面可多选；统一白底 / 黑底时先生成新 PPT，再调用黑白底互转另存 *_白底 / *_黑底 文件，原 PPT 不变。</li>
        <li><b>智能搜索</b>：检索范围可在已执行的任务中多选；搜索队列可排序、暂停；搜索历史可随时回看结果；打开结果页面自动最大化，可切换“按搜索结果 / 按文件页面”翻页。</li>
        <li><b>全新界面（3.0）</b>：重新设计整体配色（中性灰底 + 靛蓝主色，浅色 / 深色主题）、统一按钮 / 输入框 / 页签 / 表格 / 卡片样式，侧栏四个模块以主题色图标区分，弹窗、提示与空状态更清晰。</li>
        <li><b>黑白底按文件 / 文件夹批量转换</b>：选择 PPT 文件或文件夹，指定方向，输出到原目录（加后缀）或统一的新目录，原文件不改。</li>
        <li><b>黑白底互转历史</b>、<b>导出篮多选导出</b>、<b>通知管理</b>、<b>意见反馈</b>、启动时选择数据目录、文件详情键盘 / 滚轮翻页、列表列宽拖动、双击页面进入逐页浏览、对比窗口按窗格同步翻页。</li>
      </ul>
      <div className="row"><button className="btn primary" onClick={onTour}>🧭 播放新手指引（含新功能）</button></div>
    </>],
    ['start', '快速开始', <>
      <ol>
        <li>左上角 <b>＋ 添加目录</b>（或下拉 ▾ <b>添加所有本地文档</b>）。</li>
        <li>点击任务旁的 <b>▶</b> 开始解析，在“解析任务 → 解析动态”观看进度。</li>
        <li>在 <b>所有资料库</b> 查看每个文档的页面、讲解词与 Markdown；在 <b>智能搜索</b> 中检索。</li>
        <li>勾选页面 <b>加入导出篮</b>，在导出篮调整顺序后 <b>导出为新 PPT</b>。</li>
        <li>需要统一底色时，用 <b>PPT 黑白底互转</b>；需要按主题拼一份新 PPT 时，用 <b>智能生成</b>。</li>
        <li>在应用里修改讲解词后，到 <b>总览分析 → 完善讲解词</b> 对比并批量写回 PPT 备注。</li>
      </ol>
      <div className="row"><button className="btn primary" onClick={onTour}>🧭 重新播放新手指引</button><button className="btn" onClick={onWelcome}>显示启动简介</button></div>
    </>],
    ['menu', '菜单结构', <>
      <ul>
        <li><b>📂 解析任务</b>（蓝色）：所有添加的目录（任务）。点击一个任务即选中它，并在任务下方展开它的菜单——任务概览、解析过程（解析动态 / 解析历史），只显示该任务的内容；再次点击已选中的任务收起菜单。</li>
        <li><b>📊 总览分析</b>（绿色）：全部历史与所有任务——智能搜索（检索范围可多选任务）、总览分析、所有资料库、全部任务与历史（任务队列 / 解析动态 / 解析历史）、相似分组、完善讲解词。</li>
        <li><b>🤖 智能模块</b>（紫色）：导出篮、PPT 黑白底互转、智能生成（建设中）。</li>
        <li><b>🧰 维护</b>（橙色）：回收站、运行日志、通知管理（全部历史通知，点击跳转到对应界面）。</li>
        <li>有子菜单的菜单（解析过程、全部任务与历史）再次点击可折叠 / 展开子菜单。</li>
        <li>左上角“PPT智能体”旁的“❓ 帮助”打开本帮助指南，再次点击（按钮显示为“收起”）收起并回到智能搜索；最下方左侧为用户信息（预留），右侧 ⚙ 为设置（主题在设置中切换）。各分区可点击标题折叠，« 可把整个侧栏收起为图标。</li>
        <li>关闭窗口时可选择最小化到右下角图标栏（系统托盘）：单击图标恢复窗口，右击图标可完全退出。</li>
      </ul>
      <p>所有解析过程都不会改动原文件；只有在讲解词模块手动点击“写入 PPT 备注”，或在“完善讲解词”中确认批量写回后，才会写入原 PPT（写入前自动备份）。</p>
    </>],
    ['tasks', '添加目录与解析任务', <>
      <p>添加目录后任务处于“待解析”（浅橙色），需手动 ▶ 开始；多个任务按顺序排队，可在“任务队列”调整顺序、全部开始。解析中显示浅蓝色，完成为绿色。</p>
      <p>任务可随时 ⏸ 暂停（当前文件也会立即停止，继续时重新解析该文件）；程序异常关闭后再次打开，可点击“继续”从断点接着解析。名称、修改时间、大小、作者都相同的文件不会重复解析，结束时会提示并允许选择重新解析；“解析历史”保留每个文件每次的处理记录。</p>
      <p><b>添加所有本地文档</b>：按盘符顺序扫描整台电脑（跳过系统目录），添加时可选择“监测更新和新增的文件”，在 <b>设置 → 定时监测更新</b> 中设置每天增量扫描的时间点：只解析新增和修改过的文档，原文件已删除的移入回收站。</p>
    </>],
    ['parse', '解析内容说明', <>
      <p>PPT 每页提取标题、正文、表格、图片说明与 <b>讲解词（备注）</b>，生成只含文字的 Markdown；Word 按标题分节，批注作为讲解；<b>PDF 按页</b>提取文字（字号最大的行作为标题），页面预览直接渲染原 PDF，扫描版（纯图片）PDF 没有可检索的文字。内嵌或外链的视频只解析字幕，不解析画面。旧版 .ppt / .doc 需要本机安装 PowerPoint / Word 或 LibreOffice 转换。</p>
      <p>每页自动判断 <b>白底 / 黑底</b>（结合背景、主题色与页面截图）；每个文档自动打 20 个标签并归入主题分类，每页再打 8 个页面标签。</p>
    </>],
    ['library', '所有资料库', <>
      <p>页签：<b>总览</b>（每个任务 / 全部任务的统计与文档列表）、<b>PPT 总览库</b>（逐页浏览全部文档）、<b>按文件夹</b>、<b>按文件名称</b>、<b>按名称与内容归类（标签）</b>。</p>
      <p>文档详情为三栏：文件、页面列表（可多选）、页面详情（原始页 / 讲解词 / Markdown 三个模块可拖动换位、调整大小并记忆）。讲解词与 Markdown 可直接编辑，也可点击“🤖 自动调用 Agent 生成讲解词”。</p>
      <p>所有列表都可以点击列标题排序、在“☰ 列设置”中显示 / 隐藏列；每列标题旁的 <b>▾</b> 可像 Excel 一样筛选（文本 / 数字 / 日期条件，或按值勾选），工具栏可在整个列表中搜索关键字；支持多选后 <b>⧉ 对比查看</b> 或 <b>🗑 移到回收站</b>。</p>
      <p><b>统计数字下钻</b>：任务概览的文件统计、所有资料库总览、全部任务与历史的任务卡片与解析统计、解析历史的计数等，点击任意数字即打开对应的文件清单，可打开文件、在资源管理器中显示、多选对比；从清单或列表点击文件查看详情后“← 返回”，会回到原来的清单并高亮刚才查看的条目。</p>
      <p>文件详情中点击右侧推荐的页面后，标题旁出现淡橙色的 <b>↩ 返回原来的页面</b>；连续看了多个推荐时可 <b>⤒ 回到最初</b>。</p>
    </>],
    ['viewer', '逐页浏览与快捷键', <>
      <p>点击任意页面的 ⛶ 打开逐页浏览窗口，可最大化、全屏，布局可切换上1下2 / 左1右2。页面可无级缩放：Ctrl + 滚轮（以鼠标位置为中心）、右下角缩放条或 = / - 键，放大后可拖动查看，“⤢ 适配窗口”（0 键）恢复。窗口工具栏的“?”图标中列出当前快捷键；应用每个页面左下角的“?”都可查看本页的操作指导。默认快捷键：</p>
      <ul className="help-keys">
        <li><b>{k('prev')} / {k('next')}</b> 上一页 / 下一页（到末页进入下一个文件）</li>
        <li><b>{k('prevFile')} / {k('nextFile')}</b> 上一个 / 下一个文件</li>
        <li><b>{k('first')} / {k('last')}</b> 首页 / 末页</li>
        <li><b>{k('max')}</b> 最大化 · <b>{k('full')}</b> 全屏 · <b>{k('panes')}</b> 讲解词与 MD · <b>{k('layout')}</b> 切换布局</li>
        <li><b>{k('basket')}</b> 加入 / 移出导出篮 · <b>{k('rail')}</b> 相关推荐栏 · <b>{k('back')}</b> 返回推荐前的页面 · <b>{k('close')}</b> 还原 / 关闭</li>
      </ul>
      <p>所有按键都可在 <span className="link" onClick={() => app.go({ type: 'settings', focus: 'keys' })}>设置 → 快捷键</span> 中修改，例如切换为“↑ ↓ 翻页 · ← → 切换文件”。</p>
    </>],
    ['notes', '讲解词与多语言', <>
      <p>讲解词模块有三个页签：<b>原讲解词</b>（PPT 备注原文）、<b>生成讲解词</b>（建设中：调用“设置 → Agent 接口”中配置的大模型生成，需先填写 DeepSeek 等服务商的 API Key，未配置时不会生成）、<b>修正讲解词</b>（当前采用的版本，可编辑，也可一键采用原讲解词、生成讲解词或译文）。</p>
      <p>每个页签可切换 <b>原文 / 中文 / English / 小语种</b>：缺少的语言会调用 <span className="link" onClick={() => app.go({ type: 'settings', focus: 'agent' })}>设置 → Agent 接口</span> 中配置的大模型翻译。译文保存在应用知识库，不会改动原文件；需要时手动点击“写入 PPT 备注”，确认后写入原 PPT 该页备注的“【语言】”段落（写入前自动备份原文件）。Word 文档的译文只保存在知识库。</p>
      <p><b>完善讲解词</b>（总览分析 → ✍ 完善讲解词）：应用默认不修改原 PPT，在应用中修改的修正讲解词与保存的译文都集中列在这里；点击一条可对比原讲解词与修改后的内容，勾选一条或多条后“批量写入 PPT 备注”（每个文件写入前自动备份），“写回记录”保留每次写回的内容与备份位置。</p>
    </>],
    ['related', '相关推荐', <>
      <p>逐页浏览和资料库详情右侧的 <b>🔗 相关推荐</b> 栏列出本页标签与内容相近的 PPT 页面（注明标题相同、黑底 / 白底版本、共同标签、相似度）。点击推荐项在当前位置替换查看，“↩ 返回”回到原页；也可与当前页并排对比或加入导出篮。</p>
      <p>在设置中同时选择 PPT 与 Word / PDF 时，PPT 页还会推荐“相关文档内容”（Word 章节、PDF 页面），文档页面推荐“相关 PPT 页面”。</p>
    </>],
    ['search', '智能搜索', <>
      <p>支持关键词或整句、中英文混合（如“机航 turnaround”“如何缩短飞机过站时间”）。先做中英文解析与互译扩展，再按 <b>文件名 → 标签 → 内容</b>（全文 BM25 + 向量语义召回）排序，全部在本机完成（本地 RAG）。</p>
      <p>结果按 <b>白底 / 黑底 / Word / PDF</b> 分页签展示，命中词高亮并附讲解词；有另一底色版本时提示切换。“⛶ 逐页浏览”页签可用键盘逐页翻看搜索到的文档；可勾选 2–4 个相关文件并排对比。配置大模型后可让大模型解析查询并基于检索结果回答（RAG 回答）。</p>
      <p><b>搜索队列与历史</b>：输入后点击“＋ 加入队列”，多个搜索按顺序依次执行，排队中的可调整顺序、移除或暂停队列；“🗂 搜索任务与历史”列出每一次搜索（时间、内容、范围、命中文件与页数），可随时查看当次结果、重新搜索或删除；搜索首页显示最近搜索。</p>
      <p>点击结果页面后窗口自动最大化；顶部可切换 <b>按搜索结果翻页</b>（左右键在结果之间跳转，可跨文件）或 <b>按文件页面翻页</b>（与普通逐页浏览相同），选择会记住。双击任意 PPT 原版页面（缩略图或原始页）都会直接打开逐页浏览。</p>
      <p><b>检索范围</b>：搜索框旁的“🎯 范围”可选择所有资料库，或在已经执行过的任务中多选（结果为这些任务的文档并集），选择会记住，搜索历史中也记录每次的范围。</p>
    </>],
    ['export', '导出篮与导出新 PPT', <>
      <p>在搜索结果、页面列表、逐页浏览（空格键）中把页面加入导出篮。导出篮中可调整顺序、移除，然后 <b>导出为新 PPT</b>（保留原版式、母版与讲解词）或 <b>导出 Markdown</b>。保存位置按用途记住上次的选择。Word 章节不能放入 PPT，导出 PPT 时会跳过并提示。</p>
      <p>导出篮中可勾选页面（Shift 连选、全选），只把所选页面导出为新 PPT 或 Markdown；不勾选时导出全部。</p>
    </>],
    ['convert', 'PPT 黑白底互转', <>
      <p>从导出篮选择页面加入转换队列，每页可选“自动 / 转白底 / 转黑底 / 保持”。黑转白：文字黑色、表格边框浅灰、其他颜色文字深红、图形浅灰、Logo 深红；白转黑：文字白色、边框白色、视觉上透明。</p>
      <p>标题旁的 <b>⚙ 转换规则设置</b> 分“黑底转白底 / 白底转黑底”两个页签：顶部是转换前后的效果预览；“基础规则”列出原页面中的各类元素及转换后的颜色；“自定义规则”可按“元素 + 原颜色（任意或指定颜色，可设近似范围）”转换为指定颜色、保持原色或无 / 透明，优先于基础规则。新增规则在下方“新增规则”区编辑：默认放一条<b>样例</b>，修改后点 <b>💾 保存新增的规则</b> 加入自定义规则并立即保存，之后该区重新只显示一条样例；“＋ 添加规则”可再加几条；<b>没有修改过的样例在保存时一律忽略</b>，点“保存规则”时改过的新增规则也会一并保存。用自然语言生成规则为建设中。保存后下次转换生效。结果默认命名为“原文件名_白底 / _黑底”，自动加入资料库，可逐页浏览对照。</p>
      <p><b>转换历史</b>：每次转换都会保存记录（时间、输出文件、页数、黑→白 / 白→黑页数、来源文件、校验结果），点击“🕘 转换历史”可重新查看当次结果、逐页浏览、打开文件或所在位置。</p>
      <p><b>按文件 / 文件夹转换</b>：页头切换到“🗂 按文件 / 文件夹”，添加 PPT 文件或文件夹（包含子文件夹中的 PPT），选择转换方向（自动黑白互换 / 统一转为白底 / 统一转为黑底）与输出位置（默认原目录下，文件名加 _白底 / _黑底 / _黑白互转；或指定统一的新目录），点击“开始批量转换”，逐个显示进度与结果；原文件只读，同名时自动加序号不覆盖。</p>
    </>],
    ['compare', '对比窗口与相似分组', <>
      <p>在列表中勾选 2–4 个文档点击 <b>⧉ 对比查看</b>：并排或田字格显示，每个窗格有独立翻页按钮；“一起翻页”时同步翻动，单独翻某个窗格即可跳过一页后继续一起翻；支持对齐页码、按标题对齐、文字相似度提示。</p>
      <p><b>相似分组</b> 先按标题、再按内容把相近的 PPT 归为一组（如黑底 / 白底版本、不同版本副本），左侧分组列表可按名称、文件数、大小排序与筛选，右侧显示所选分组的全部文件，每组可一键对比。</p>
      <p>对比窗口中每个窗格标题旁有“同步翻页”勾选框：勾选 1 个或多个窗格，“一起翻页”只翻动勾选的窗格；都不勾选时只翻当前选中的窗格。</p>
    </>],
    ['analytics', '总览分析与回收站', <>
      <p><b>总览分析</b> 展示近期（一天 / 一周 / 一个月）访问或修改过的文档、很久没打开的文档（半年 / 1 年 / 2 年 / 3 年），以及读写统计图表。点击任意统计数字或柱形 / 条形可打开对应的文件清单，清单中可直接打开文件或在资源管理器中显示。右上角可设置统计的刷新频率（每次打开 / 每天 / 每周 / 仅手动）。</p>
      <p>删除一律先进 <b>回收站</b>：可以连同原文件移入回收站，或仅从资料库移除；回收站中可还原，“彻底删除”需二次确认。</p>
    </>],
    ['settings', '设置', <>
      <p>解析文档类型（PPT / Word / PDF 多选）、定时监测更新、<b>Agent 接口</b>（DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama 等大模型，用于讲解词生成与翻译、查询解析、打标签；应用不内置任何 API Key）、界面主题（黑 / 白 / 跟随系统）、快捷键、关闭窗口时的行为（询问 / 最小化 / 退出）、数据保存目录（可迁移）、页面截图引擎（PowerPoint / LibreOffice）、语义向量（可选）、相似阈值与重新计算。</p>
      <p>运行日志只保留一份（“运行日志”菜单），完整记录工作过程。</p>
      <p><b>启动时选择数据目录</b>：程序打开时可先选择保存解析数据的目录（当前目录、使用过的历史目录或新目录）；勾选“记住选择”后下次不再询问，可在 <b>设置 → 数据保存目录</b> 中重新开启。</p>
      <p><b>意见反馈</b>：左下角 💬 填写问题或建议后发送，在后台发送给开发者；需先在 <b>设置 → 反馈邮件发送设置</b> 配置发件邮箱（SMTP 与授权码），未配置时反馈先保存在本机，配置后自动补发。</p>
      <p><b>鼠标滚轮</b>：在 PPT 页面上滚动滚轮翻页，Ctrl + 滚轮放大缩小；两项都可在 <b>设置 → 快捷键</b> 中关闭。左下角 ⚙ 再次点击收起设置并回到原来的界面。</p>
    </>],
  ];
  return (
    <div className="view">
      <div className="view-head"><div className="vh-title">📖 帮助指南 <span className="muted small">功能详解与操作说明</span></div><div className="spacer" />
        <button className="btn" onClick={onWelcome}>显示启动简介</button><button className="btn primary" onClick={onTour}>🧭 新手指引</button></div>
      <div className="help">
        <nav className="help-toc">{SECTIONS.map(([id, t]) => <div key={id} className="link" onClick={() => { const el = body.current && body.current.querySelector(`#help-${id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{t}</div>)}</nav>
        <div className="help-body" ref={body}>{SECTIONS.map(([id, t, c]) => <section key={id} id={`help-${id}`}><h3>{t}</h3>{c}</section>)}</div>
      </div>
    </div>
  );
}
