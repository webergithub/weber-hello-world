'use strict';
// 单一运行日志：所有工作过程写入同一个文件，超过上限时裁掉最旧的一半（始终只保留 1 份日志）。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_BYTES = 20 * 1024 * 1024;

class Logger extends EventEmitter {
  constructor() {
    super();
    this.file = null;
    this.buffer = [];
  }

  init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'ppt-agent.log');
    for (const line of this.buffer) fs.appendFileSync(this.file, line + '\n');
    this.buffer = [];
    this.trim();
  }

  trim() {
    try {
      const st = fs.statSync(this.file);
      if (st.size <= MAX_BYTES) return;
      const buf = fs.readFileSync(this.file);
      let start = buf.length - Math.floor(MAX_BYTES / 2);
      while (start < buf.length && buf[start] !== 0x0a) start++;
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from(`[${stamp()}] [INFO] [logger] 日志超过 ${MAX_BYTES >> 20}MB，已裁剪旧记录\n`), buf.subarray(start + 1)]));
    } catch { /* 文件不存在时忽略 */ }
  }

  write(level, mod, msg, extra) {
    let text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    if (extra instanceof Error) text += ` | ${extra.message}${extra.stack ? '\n' + extra.stack.split('\n').slice(1, 4).join('\n') : ''}`;
    else if (extra !== undefined) text += ' | ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    const line = `[${stamp()}] [${level}] [${mod}] ${text}`;
    if (this.file) {
      try { fs.appendFileSync(this.file, line + '\n'); } catch { /* 磁盘错误不影响主流程 */ }
      if (Math.random() < 0.002) this.trim();
    } else {
      this.buffer.push(line);
    }
    if (process.env.PPTA_LOG_STDOUT) console.log(line);
    this.emit('line', line);
    return line;
  }

  child(mod) {
    return {
      info: (m, e) => this.write('INFO', mod, m, e),
      warn: (m, e) => this.write('WARN', mod, m, e),
      error: (m, e) => this.write('ERROR', mod, m, e),
      debug: (m, e) => this.write('DEBUG', mod, m, e),
    };
  }

  tail(maxLines = 2000) {
    if (!this.file || !fs.existsSync(this.file)) return this.buffer.slice(-maxLines);
    const st = fs.statSync(this.file);
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  }

  clear() {
    if (this.file) fs.writeFileSync(this.file, '');
    this.write('INFO', 'logger', '日志已清空');
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

module.exports = new Logger();
