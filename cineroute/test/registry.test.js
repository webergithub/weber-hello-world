/**
 * 媒体地址白名单测试。
 *
 * /media 代理与 /api/download 都以此为准入闸。这道闸一旦漏，
 * 本地服务就变成一个开放代理：任何人都能借它请求内网地址
 * （云元数据服务 169.254.169.254、内网管理口……）。所以这里
 * 用例写得比功能测试更严——宁可误伤，不可放行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedMediaUrl, ADAPTERS, adapterAvailability, getAdapter } from '../src/adapters/registry.js';

test('白名单放行已登记的片源域名', () => {
  for (const url of [
    'https://archive.org/download/x/y.mp4',
    'https://ia801509.us.archive.org/27/items/x/y.mp4',
    'https://upload.wikimedia.org/wikipedia/commons/4/4e/x.webm',
    'https://commons.wikimedia.org/w/api.php',
  ]) {
    assert.equal(isAllowedMediaUrl(url).ok, true, `${url} 应放行`);
  }
});

test('拒绝内网与云元数据地址（SSRF 防线）', () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8787/api/config',
    'http://localhost/admin',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/',
    'http://[::1]:8080/',
  ]) {
    assert.equal(isAllowedMediaUrl(url).ok, false, `${url} 必须拒绝`);
  }
});

test('拒绝任意外部域名', () => {
  assert.equal(isAllowedMediaUrl('https://evil.example.com/x.mp4').ok, false);
  assert.equal(isAllowedMediaUrl('https://archive.org.evil.com/x.mp4').ok, false);
});

test('拒绝非 HTTP(S) 协议', () => {
  assert.equal(isAllowedMediaUrl('file:///etc/passwd').ok, false);
  assert.equal(isAllowedMediaUrl('ftp://archive.org/x.mp4').ok, false);
  assert.equal(isAllowedMediaUrl('gopher://archive.org/').ok, false);
});

test('拒绝无法解析的地址', () => {
  assert.equal(isAllowedMediaUrl('not a url').ok, false);
  assert.equal(isAllowedMediaUrl('').ok, false);
});

test('用户显式配置的 Jellyfin 服务器被视为已授权', (t) => {
  const prev = process.env.JELLYFIN_URL;
  process.env.JELLYFIN_URL = 'http://media.lan:8096';
  t.after(() => {
    if (prev === undefined) delete process.env.JELLYFIN_URL;
    else process.env.JELLYFIN_URL = prev;
  });

  assert.equal(isAllowedMediaUrl('http://media.lan:8096/Videos/1/stream.mp4').ok, true);
  // 授权只覆盖那一台主机，不外溢
  assert.equal(isAllowedMediaUrl('http://other.lan:8096/x.mp4').ok, false);
});

test('注册表里每个适配器都申明了必要字段', () => {
  for (const a of ADAPTERS) {
    assert.ok(a.id && a.label, '适配器需有 id 与 label');
    assert.ok(['direct', 'metadata'].includes(a.kind), `${a.id} 的 kind 非法`);
    assert.equal(typeof a.search, 'function', `${a.id} 缺少 search`);
    if (a.requiresConfig) assert.ok(a.configHint, `${a.id} 需说明如何配置`);
  }
});

test('缺配置的适配器被标记为不可用并给出配置指引', (t) => {
  const prevTmdb = process.env.TMDB_API_KEY;
  const prevJf = process.env.JELLYFIN_URL;
  delete process.env.TMDB_API_KEY;
  delete process.env.JELLYFIN_URL;
  t.after(() => {
    if (prevTmdb !== undefined) process.env.TMDB_API_KEY = prevTmdb;
    if (prevJf !== undefined) process.env.JELLYFIN_URL = prevJf;
  });

  const tmdb = adapterAvailability(getAdapter('tmdb'));
  assert.equal(tmdb.available, false);
  assert.match(tmdb.reason, /TMDB_API_KEY/);

  // 免配置的源永远可用
  assert.equal(adapterAvailability(getAdapter('internet-archive')).available, true);
});
