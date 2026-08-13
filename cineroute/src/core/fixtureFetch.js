/**
 * 夹具驱动的 fetch 替身。
 *
 * 用途有二：
 *  1) `--offline` 演示模式：没网、没 API key 也能完整跑通全链路 UI；
 *  2) 测试：让 `node --test` 在无网环境下验证**真实的解析与打分代码路径**，
 *     而不是去测一个假适配器——夹具喂给的是货真价实的上游响应结构。
 *
 * 匹配规则见 fixtures/manifest.json：每条 `when` 是一组子串，
 * 全部命中 URL 即返回对应文件。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_DIR = path.resolve(HERE, '../../fixtures');

/**
 * 离线模式下的 SERP 配置。
 *
 * 走 custom 模板是有意的：它把 engine 与查询词放进 URL，夹具才能按引擎分别匹配，
 * 离线演示里 Google 与百度就能返回不同的结果页。顺带也把 custom 这条
 * "自己接别的 SERP 服务"的路径跑了一遍。
 *
 * 只在用户没配真 SERP 服务时才套用——已经配了就别覆盖人家的。
 */
export const FIXTURE_SERP_ENV = {
  CINEROUTE_SERP_PROVIDER: 'custom',
  CINEROUTE_SERP_URL: 'https://serp.fixture/search?engine={engine}&q={query}&page={page}',
};

export function applyFixtureSerpEnv(env = process.env) {
  if (env.CINEROUTE_SERP_PROVIDER) return false;
  Object.assign(env, FIXTURE_SERP_ENV);
  return true;
}

/**
 * 创建一个签名与 httpJson 兼容的函数。
 * @param {string} [dir]
 * @returns {(url: string, opts?: object) => Promise<any>}
 */
export function createFixtureFetch(dir = DEFAULT_FIXTURE_DIR) {
  let manifestPromise = null;

  const loadManifest = () => {
    if (!manifestPromise) {
      manifestPromise = readFile(path.join(dir, 'manifest.json'), 'utf8').then(JSON.parse);
    }
    return manifestPromise;
  };

  return async function fixtureFetch(url) {
    const manifest = await loadManifest();
    const raw = String(url);
    // URLSearchParams 把空格编码成 '+'，所以要同时准备三种形态来匹配：
    // 原始串、百分号解码串、以及把 '+' 还原成空格后再解码的串。
    const candidates = [raw];
    try { candidates.push(decodeURIComponent(raw)); } catch { /* 编码异常则跳过 */ }
    try { candidates.push(decodeURIComponent(raw.replace(/\+/g, ' '))); } catch { /* 同上 */ }

    const entry = manifest.find((e) =>
      e.when.every((needle) => candidates.some((c) => c.includes(needle))),
    );
    if (!entry) {
      throw new Error(`夹具未覆盖此请求：${url}`);
    }
    const file = path.join(dir, entry.file);
    if (!existsSync(file)) throw new Error(`夹具文件缺失：${entry.file}`);
    return JSON.parse(await readFile(file, 'utf8'));
  };
}

/**
 * 离线模式下的探测替身：不发网络请求，按容器给出合理的默认值。
 * archive.org 与 Commons 的下载域实际都支持 Range 且开放 CORS，
 * 这里如实反映，以免离线演示的排序与联网结果差异过大。
 */
export function createFixtureProbe() {
  return async function fixtureProbe(url) {
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const supportsRange = /archive\.org$|wikimedia\.org$/.test(host) || host.endsWith('.archive.org');
    return {
      ok: true,
      status: supportsRange ? 206 : 200,
      headers: new Headers(
        supportsRange
          ? { 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' }
          : {},
      ),
    };
  };
}
