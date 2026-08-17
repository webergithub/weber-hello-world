/**
 * 检索进度的粗算模型。
 *
 * 「粗算」是认真的用词：这条管线里没有一步能事先知道自己要花多久——
 * 引擎返回多少条、多少条需要探测、上游多慢，都得跑起来才知道。
 * 所以百分比不是测出来的，是按各阶段的**经验权重**摊出来的：
 * 阶段内部有可数的单位（几个源、几条候选）就按完成比例插值，
 * 没有就在进入时记该阶段起点、结束时推到终点。
 *
 * 这样得到的数字不精确，但两个性质是成立的，而这正是进度条要的：
 *   1) 单调不减 —— 不会跳回去；
 *   2) 到 100% 时确实全跑完了。
 *
 * 权重按实测排的：发现（引擎并发翻页）最慢，探测次之，其余基本是内存计算。
 */

/** 阶段顺序即执行顺序，weight 是各自占总进度的份额。 */
export const PHASES = [
  { key: 'plan', label: '规划检索词', weight: 2 },
  // 优先来源与其他源是**并发**跑的，所以不单列一个阶段——单列就得等它跑完
  // 才能进下一阶段，等于把并发改成串行。它的收工消息出现在这一阶段的日志里。
  { key: 'discovery', label: '各来源并发检索', weight: 50 },
  { key: 'expand', label: '推荐词补搜', weight: 14 },
  { key: 'normalize', label: '归一去重', weight: 4 },
  { key: 'prerank', label: '预排名', weight: 3 },
  { key: 'probe', label: '嗅探探测', weight: 22 },
  { key: 'rank', label: '打分排序', weight: 4 },
  { key: 'assemble', label: '组装结果', weight: 1 },
];

const TOTAL = PHASES.reduce((n, p) => n + p.weight, 0);

/** 某阶段起点在总进度里的位置（0-100）。 */
export function phaseStart(key) {
  let acc = 0;
  for (const p of PHASES) {
    if (p.key === key) break;
    acc += p.weight;
  }
  return (acc / TOTAL) * 100;
}

export function phaseWeight(key) {
  const p = PHASES.find((x) => x.key === key);
  return p ? (p.weight / TOTAL) * 100 : 0;
}

/**
 * 造一个进度上报器。
 *
 * 没传回调时返回一组空操作，调用方不必到处判空——管线里进度上报是穿插在
 * 主流程中间的，每处都写 `if (onProgress)` 会把逻辑割得很碎。
 *
 * @param {(ev: object) => void} [onProgress]
 */
export function createReporter(onProgress) {
  if (typeof onProgress !== 'function') {
    return { phase() {}, step() {}, note() {}, done() {}, fail() {} };
  }

  const startedAt = Date.now();
  let pct = 0;
  let current = null;

  const emit = (ev) => {
    // 单调不减：任何一处算出更小的值都按上一次的报，进度条不能倒退
    pct = Math.max(pct, Math.min(100, ev.pct ?? pct));
    try {
      onProgress({ ...ev, pct: Math.round(pct), elapsedMs: Date.now() - startedAt });
    } catch { /* 上报失败不该拖垮检索本身 */ }
  };

  return {
    /** 进入一个阶段。 */
    phase(key, detail = null) {
      const p = PHASES.find((x) => x.key === key);
      current = key;
      emit({
        type: 'phase', phase: key, label: p?.label ?? key,
        detail, pct: phaseStart(key), status: 'running',
      });
    },

    /**
     * 阶段内的进度：done/total 用来在本阶段的份额里插值。
     * `label` 是当前正在做的那件事，界面直接显示它。
     */
    step(label, { done = 0, total = 0, status = 'running', detail = null } = {}) {
      const base = phaseStart(current);
      const span = phaseWeight(current);
      const inner = total > 0 ? Math.min(1, done / total) : 0;
      emit({
        type: 'step', phase: current, label, detail, status,
        done, total, pct: base + span * inner,
      });
    },

    /** 一条不影响进度的消息（某个源出错、被跳过之类）。 */
    note(label, { status = 'info', detail = null } = {}) {
      emit({ type: 'note', phase: current, label, detail, status });
    },

    done(detail = null) {
      emit({ type: 'done', phase: 'done', label: '完成', detail, pct: 100, status: 'ok' });
    },

    fail(message) {
      emit({ type: 'failed', phase: current, label: '检索失败', detail: message, status: 'error' });
    },
  };
}
