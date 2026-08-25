/**
 * 策略阶梯：先便宜的，被挡了再往上升。
 *
 * 三种拿结果的方式代价差着量级：
 *
 *   http     几十毫秒，不占内存，但最容易被认出来是脚本
 *   browser  两三秒（还要先把 Chromium 拉起来），但过得去大部分检测
 *   api      最稳，按次收费
 *
 * 固定用某一种都不划算：全走 http 会经常空手而归，全走 browser 则是
 * 拿大炮打蚊子——DuckDuckGo 的 html 端点用 http 抓得又快又准，
 * 没有任何理由为它开一个浏览器。
 *
 * 所以做成阶梯：**按引擎的实际情况从便宜的开始试，只在被挡时升级**。
 * 升级不是无条件的——如果这一跳根本没配（没有浏览器实例、没有 API key），
 * 就如实说"到此为止"，而不是假装还有别的办法。
 *
 * 另一件要说清楚的事：**被挡 ≠ 没结果**。这两件事的处理方式完全不同，
 * 混在一起是这类框架最常见的毛病——把验证码页当成"这个词搜不到东西"，
 * 于是既不重试也不升级，安静地给出一个空结果。
 */

import { httpSearchPage, httpSupported } from './httpSearch.js';
import { recipeFor } from './engines.js';

/** 一次尝试的记录。留着给界面显示"这条结果是怎么拿到的"。 */
function attempt(strategy, ok, detail, elapsedMs = 0) {
  return { strategy, ok, detail, elapsedMs };
}

/**
 * 按阶梯搜一页。
 *
 * @param {string} engine
 * @param {string} query
 * @param {number} page
 * @param {{
 *   order?: string[],                       想按什么顺序试，默认按引擎情况决定
 *   browserSearch?: Function,               浏览器策略的实现（由调用方注入，避免循环依赖）
 *   apiSearch?: Function,                   api 策略的实现
 *   fetchFn?: Function, signal?: AbortSignal,
 *   baseUrl?: string,                       SearXNG 实例地址
 *   skipThrottle?: boolean,
 * }} [opts]
 * @returns {Promise<{results, related, strategy, blocked, attempts}>}
 */
export async function searchWithLadder(engine, query, page = 1, opts = {}) {
  const { browserSearch, apiSearch, order } = opts;
  const recipe = recipeFor(engine);

  // 默认顺序：能走 http 的先走 http，然后浏览器，最后 api。
  // 明确标了 httpOk:false 的（比如 Yandex 几乎必弹验证码）直接从浏览器起步，
  // 省掉一次注定失败的请求。
  const plan = order ?? [
    ...(recipe.httpOk ? ['http'] : []),
    ...(browserSearch ? ['browser'] : []),
    ...(apiSearch ? ['api'] : []),
  ];

  const attempts = [];
  let lastBlocked = null;

  for (const strategy of plan) {
    try {
      if (strategy === 'http') {
        if (!httpSupported(engine) && !recipe.generic) {
          attempts.push(attempt('http', false, '这家引擎不适合纯 HTTP 抓取'));
          continue;
        }
        const r = await httpSearchPage(engine, query, page, opts);
        if (r.blocked) {
          lastBlocked = r.blocked;
          attempts.push(attempt('http', false, `被挡：${r.blocked}`, r.elapsedMs));
          continue;
        }
        if (r.results.length === 0) {
          // 没被挡但也没结果：可能这一页真的到底了。这是**正常结束**，
          // 不该升级到浏览器再白跑一次。
          attempts.push(attempt('http', true, '没有结果（未被拦截）', r.elapsedMs));
          return { ...r, strategy: 'http', attempts };
        }
        attempts.push(attempt('http', true, `${r.results.length} 条`, r.elapsedMs));
        return { ...r, strategy: 'http', attempts };
      }

      if (strategy === 'browser') {
        if (!browserSearch) {
          attempts.push(attempt('browser', false, '没有可用的浏览器实例'));
          continue;
        }
        const r = await browserSearch(engine, query, page);
        if (r.suspectBlocked) {
          lastBlocked = r.blockReason || '疑似触发反自动化拦截';
          attempts.push(attempt('browser', false, `被挡：${lastBlocked}`, r.elapsedMs ?? 0));
          continue;
        }
        attempts.push(attempt('browser', true, `${r.results.length} 条`, r.elapsedMs ?? 0));
        return { ...r, blocked: null, strategy: 'browser', attempts };
      }

      if (strategy === 'api') {
        if (!apiSearch) {
          attempts.push(attempt('api', false, '未配置 SERP 服务'));
          continue;
        }
        const r = await apiSearch(engine, query, page);
        attempts.push(attempt('api', true, `${r.results.length} 条`, r.elapsedMs ?? 0));
        return { ...r, blocked: null, strategy: 'api', attempts };
      }
    } catch (err) {
      attempts.push(attempt(strategy, false, String(err?.message || err)));
    }
  }

  // 全都没成。**说清楚是被挡了还是没配**——这两件事用户要做的处理完全不同。
  return {
    results: [],
    related: [],
    strategy: null,
    blocked: lastBlocked,
    attempts,
    reason: lastBlocked
      ? `${recipe.label} 的所有策略都被拦下了（最后一次：${lastBlocked}）`
      : `${recipe.label} 没有可用的检索策略：${attempts.map((a) => a.detail).join('；')}`,
  };
}

/**
 * 把一次阶梯尝试整理成人能读的一行。
 * 界面上要让用户看见"这条结果是用什么方式拿到的、中间试了什么"。
 */
export function describeAttempts(attempts) {
  return (attempts || [])
    .map((a) => `${a.strategy}${a.ok ? '✓' : '✗'} ${a.detail}${a.elapsedMs ? ` (${a.elapsedMs}ms)` : ''}`)
    .join(' → ');
}
