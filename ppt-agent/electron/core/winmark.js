'use strict';
// Windows 下载标记（Mark of the Web）：浏览器 / 聊天工具下载的文件带有 “:Zone.Identifier” 附加数据流，
// 未签名的 exe 每次启动都会因此被 SmartScreen 拦截询问。用户第一次已选择“仍要运行”后，
// 程序去掉自身 exe 的这个标记（等同于 右键 → 属性 → 解除锁定），以后启动不再弹出 SmartScreen。
// 只处理程序自己的 exe，不改动其他任何文件。
const fs = require('fs');

/** 返回 'cleared'（已去掉）、'none'（本来就没有标记）或 'failed'（无法去掉，附 error） */
function clearDownloadMark(exe, platform = process.platform, fsImpl = fs) {
  if (platform !== 'win32' || !exe) return { result: 'none' };
  const stream = exe + ':Zone.Identifier';
  try {
    fsImpl.unlinkSync(stream);
    return { result: 'cleared', file: exe };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { result: 'none' };
    return { result: 'failed', file: exe, error: String((e && e.message) || e) };
  }
}

module.exports = { clearDownloadMark };
