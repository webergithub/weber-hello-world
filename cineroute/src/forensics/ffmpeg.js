/**
 * ffmpeg 适配层 —— 只让它做「解码 + 缩放 + 转灰度」。
 *
 * 刻意不用 ffmpeg 的分析滤镜（signature / blackdetect / freezedetect 等），
 * 因为那些依赖具体构建是否编入；而 decode+scale+gray 是任何 ffmpeg 构建都有的。
 * 输出裸 rawvideo 灰度流，每帧恰好 width×height 字节，无需任何图像解码库。
 *
 * ⚠️ 本文件的代码路径**未在开发环境实测**：该环境没有可用的 ffmpeg
 * （仅有 Playwright 自带的 --disable-everything 构建，无 H.264 解码器）。
 * 容器层与帧分析算法均已离线验证，缺的只是这一层的进程调用。
 */

import { spawn } from 'node:child_process';

const FFMPEG = process.env.CINEROUTE_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.CINEROUTE_FFPROBE || 'ffprobe';

/** 探测 ffmpeg 是否可用。 */
export function checkFfmpeg(bin = FFMPEG) {
  return new Promise((resolve) => {
    const p = spawn(bin, ['-hide_banner', '-version']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ available: false, reason: `找不到可执行文件 ${bin}` }));
    p.on('close', (code) => {
      if (code !== 0) { resolve({ available: false, reason: `${bin} 退出码 ${code}` }); return; }
      const version = out.split('\n')[0] || '';
      // Playwright 等精简构建没有 H.264 解码器，用不了
      const stripped = /--disable-everything/.test(out);
      resolve({
        available: !stripped,
        version: version.trim(),
        reason: stripped ? '该 ffmpeg 为 --disable-everything 精简构建，缺少视频解码器' : null,
      });
    });
  });
}

/**
 * 抽取裸灰度帧。
 *
 * @param {string} file
 * @param {{width?:number, height?:number, fps?:string|number, ffmpegPath?:string,
 *          maxFrames?:number, timeoutMs?:number}} [opts]
 *   fps 支持分数写法，如 '1/10' 表示每 10 秒一帧。
 * @returns {Promise<{frames: Uint8Array[], width:number, height:number}>}
 */
export function extractGrayFrames(file, opts = {}) {
  const {
    width = 160,
    height = 90,
    fps = '1/10',
    ffmpegPath = FFMPEG,
    maxFrames = 2000,
    timeoutMs = 10 * 60 * 1000,
  } = opts;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-vf', `fps=${fps},scale=${width}:${height}:flags=bilinear`,
    '-pix_fmt', 'gray',
    '-f', 'rawvideo',
    '-',
  ];

  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    const frameSize = width * height;
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let stderr = '';

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`ffmpeg 抽帧超时（>${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    p.stdout.on('data', (d) => {
      chunks.push(d);
      total += d.length;
      // 够了就掐掉，避免整片解码
      if (total >= frameSize * maxFrames) p.kill('SIGTERM');
    });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (err) => { clearTimeout(timer); reject(err); });

    p.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks, total);
      const count = Math.floor(buf.length / frameSize);
      if (count === 0) {
        reject(new Error(`ffmpeg 未输出任何帧${stderr ? `：${stderr.trim().split('\n')[0]}` : ''}`));
        return;
      }
      const frames = [];
      for (let i = 0; i < count; i += 1) {
        frames.push(new Uint8Array(buf.subarray(i * frameSize, (i + 1) * frameSize)));
      }
      resolve({ frames, width, height });
    });
  });
}

/**
 * 用 ffprobe 取一份结构化媒体信息，作为容器解析的交叉校验
 * （尤其是非 MP4 容器：MKV/AVI 走不了 ISOBMFF 解析）。
 */
export function ffprobeJson(file, ffprobePath = FFPROBE) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-show_format', '-show_streams', '-print_format', 'json', file,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffprobe 退出码 ${code}：${err.trim()}`)); return; }
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

export { FFMPEG, FFPROBE };
