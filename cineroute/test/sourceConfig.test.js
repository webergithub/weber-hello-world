/**
 * 数据源配置测试。
 *
 * 这一层决定"这次检索跑哪些源、每个取多少条"，是用户唯一能改的旋钮，
 * 所以规范化必须扛得住手改坏的配置文件：非法数量、重复 id、缺字段、
 * 整个文件损坏。任何一种都不能让检索崩掉——最坏也要回落到出厂默认。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSource, normalizeConfig, defaultConfig, loadConfig, saveConfig,
  limitFor, enabledSources, DEFAULT_LIMIT, DEFAULT_SOURCES, DEFAULT_SITE_SCOPE,
  SITE_SCOPE_SUGGESTIONS,
} from '../src/core/sourceConfig.js';

test('出厂默认：五个引擎都在且都已勾选，各取前 100 条', () => {
  const cfg = defaultConfig();
  for (const engine of ['google', 'bing', 'baidu', 'yandex', 'duckduckgo']) {
    const s = cfg.sources.find((x) => x.id === `engine:${engine}`);
    assert.ok(s, `默认应包含 ${engine}`);
    assert.equal(s.enabled, true, `${engine} 默认应勾选`);
    assert.equal(s.limit, 100, `${engine} 默认应取前 100 条`);
    assert.equal(s.type, 'engine');
  }
  assert.equal(cfg.defaults.limit, DEFAULT_LIMIT);
});

test('出厂默认：专用数据源也都在，且各有自己的数量', () => {
  const cfg = defaultConfig();
  for (const id of ['internet-archive', 'wikimedia-commons', 'jellyfin', 'tmdb']) {
    assert.ok(cfg.sources.some((s) => s.id === id), `默认应包含 ${id}`);
  }
  // 数量是逐源配置的，不是一刀切
  const limits = new Set(cfg.sources.map((s) => s.limit));
  assert.ok(limits.size > 1, '各源数量应可不同');
});

test('每个引擎可以单独设不同的数量', () => {
  const cfg = normalizeConfig({
    defaults: { limit: 100 },
    sources: [
      { id: 'engine:google', type: 'engine', engine: 'google', enabled: true, limit: 100 },
      { id: 'engine:baidu', type: 'engine', engine: 'baidu', enabled: true, limit: 30 },
      { id: 'engine:bing', type: 'engine', engine: 'bing', enabled: false, limit: 50 },
    ],
  });
  assert.equal(limitFor(cfg, 'engine:google'), 100);
  assert.equal(limitFor(cfg, 'engine:baidu'), 30);
  assert.equal(limitFor(cfg, 'engine:bing'), 50);
  // 关掉的源不参与检索，但它的数量设置保留着
  assert.deepEqual(enabledSources(cfg).map((s) => s.id), ['engine:google', 'engine:baidu']);
});

test('没单独配数量的源用全局默认值', () => {
  const cfg = normalizeConfig({
    defaults: { limit: 42 },
    sources: [{ id: 'engine:google', type: 'engine', engine: 'google', enabled: true }],
  });
  assert.equal(limitFor(cfg, 'engine:google'), 42);
});

test('用户可以自己加引擎，engine 字段能从 id 推出来', () => {
  const s = normalizeSource({ id: 'engine:yandex', type: 'engine', limit: 20 });
  assert.equal(s.engine, 'yandex');
  assert.equal(s.limit, 20);
});

test('非法数量被夹到合法区间，而不是原样写进去', () => {
  assert.equal(normalizeSource({ id: 'a', limit: -5 }).limit, 1);
  assert.equal(normalizeSource({ id: 'a', limit: 99999 }).limit, 1000);
  assert.equal(normalizeSource({ id: 'a', limit: 12.7 }).limit, 13);
  // 完全不是数字 → 回落到默认
  assert.equal(normalizeSource({ id: 'a', limit: 'abc' }).limit, DEFAULT_LIMIT);
});

test('坏配置不会让系统崩：缺 id 丢弃、重复 id 只留第一条', () => {
  const cfg = normalizeConfig({
    sources: [
      { id: 'engine:google', type: 'engine', enabled: true, limit: 10 },
      { id: 'engine:google', type: 'engine', enabled: false, limit: 999 },  // 重复
      { type: 'engine', limit: 5 },                                          // 缺 id
      null,
      'not-an-object',
    ],
  });
  assert.equal(cfg.sources.length, 1);
  assert.equal(cfg.sources[0].limit, 10, '应保留第一条');
});

test('sources 被清空时回落到出厂源，不会变成"什么都不搜"', () => {
  const cfg = normalizeConfig({ sources: [] });
  assert.equal(cfg.sources.length, DEFAULT_SOURCES.length);
});

test('站点范围出厂不限定；填了才生效，清空就是真的清空', () => {
  // 出厂空 = 全网搜。以前这里预置了一串归档站，引擎只在那几个站里翻，
  // 而那几个站本来就有专用适配器——引擎这条线等于什么新东西都发现不了。
  assert.deepEqual(DEFAULT_SITE_SCOPE, []);
  assert.deepEqual(normalizeConfig({}).siteScope, []);

  const custom = normalizeConfig({ siteScope: ['archive.org', '  ', 'example.org'] });
  assert.deepEqual(custom.siteScope, ['archive.org', 'example.org']);

  // 空数组就是"不限定"，不能悄悄套回默认列表——设置页上写着"清空即全网搜"，
  // 以前那句话是假的，用户怎么删都会被存回原样。
  assert.deepEqual(normalizeConfig({ siteScope: [] }).siteScope, []);
});

test('已经存过的旧出厂列表当作没配过；动过的原样保留', () => {
  // 旧版把那九个域名当默认值写进了配置文件。已经在设置页存过一次的人，
  // 文件里躺着的是一份他从没主动选过的限定——不认这件事，"默认改成全网搜"
  // 对这些人就等于没改：拉了新代码，行为一模一样。
  assert.deepEqual(
    normalizeConfig({ siteScope: [...SITE_SCOPE_SUGGESTIONS] }).siteScope, [],
    '原封不动的旧列表应当被当作没配过',
  );
  // 顺序不同也算同一份
  assert.deepEqual(
    normalizeConfig({ siteScope: [...SITE_SCOPE_SUGGESTIONS].reverse() }).siteScope, [],
  );

  // 只要动过一条，就是用户自己的选择，一个字都不许改
  const trimmed = SITE_SCOPE_SUGGESTIONS.slice(0, -1);
  assert.deepEqual(normalizeConfig({ siteScope: trimmed }).siteScope, trimmed, '删过一条就该保留');
  const added = [...SITE_SCOPE_SUGGESTIONS, 'my-archive.example'];
  assert.deepEqual(normalizeConfig({ siteScope: added }).siteScope, added, '加过一条就该保留');
});

test('配置文件损坏或不存在时回落到出厂默认，不抛异常', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-cfg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const missing = path.join(dir, 'nope.json');
  assert.deepEqual(await loadConfig(missing), defaultConfig());

  const broken = path.join(dir, 'broken.json');
  await fs.writeFile(broken, '{ this is not json');
  assert.deepEqual(await loadConfig(broken), defaultConfig());
});

test('存盘再读回来内容一致，且非法值在落盘前就被修正', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cineroute-cfg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'sources.json');   // 目录不存在也要能写

  const saved = await saveConfig({
    defaults: { limit: 100 },
    sources: [{ id: 'engine:baidu', type: 'engine', engine: 'baidu', enabled: true, limit: 88888 }],
    siteScope: ['archive.org'],
  }, file);

  assert.equal(saved.sources[0].limit, 1000, '落盘前应先夹到上限');
  assert.deepEqual(await loadConfig(file), saved);
});
