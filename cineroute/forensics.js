#!/usr/bin/env node
/**
 * CineRoute 视频取证 —— 命令行入口。
 *
 *   node forensics.js <嫌疑副本>
 *   node forensics.js <嫌疑副本> --reference <参考母版>
 *   node forensics.js <嫌疑副本> --json report.json
 *   node forensics.js <嫌疑副本> --overlay          （需本机 ffmpeg）
 *
 * 本工具只分析你已经取得的本地文件，不负责获取。
 */

import fs from 'node:fs/promises';
import { analyze, renderText } from './src/forensics/report.js';
import { checkFfmpeg, extractGrayFrames } from './src/forensics/ffmpeg.js';
import { detectStaticOverlays } from './src/forensics/frames.js';

const HELP = `
CineRoute 视频取证 — 同一性甄别与后期加工识别

用法：
  node forensics.js <嫌疑副本> [选项]

选项：
  --reference <文件>   与参考母版比对：判定同一性并精确定位插入/缺失段
  --json <文件>        导出机器可读报告（JSON）
  --overlay            检测烧录进画面的台标/水印/URL（需本机 ffmpeg）
  --bin <秒>           码率剖面的时间粒度，默认 1
  --no-hash            跳过 sha256/md5 计算（大文件加速，但报告不具证据效力）

环境变量：
  CINEROUTE_FFMPEG     ffmpeg 可执行文件路径（默认 ffmpeg）

说明：
  容器层分析（码率剖面、GOP 节奏、编码溯源、母版比对）为纯 JS 实现，
  仅支持 MP4/MOV/M4V；--overlay 的像素层分析需要本机 ffmpeg。
`.trim();

function parseArgs(argv) {
  const out = { file: null, reference: null, json: null, overlay: false, binSec: 1, hash: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--reference') out.reference = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--overlay') out.overlay = true;
    else if (a === '--bin') out.binSec = Number(argv[++i]) || 1;
    else if (a === '--no-hash') out.hash = false;
    else if (!a.startsWith('--') && !out.file) out.file = a;
  }
  return out;
}

/** 像素层：跨全片采样帧 → 逐像素时间方差 → 静态叠加物。 */
async function runOverlayDetection(file) {
  const check = await checkFfmpeg();
  if (!check.available) {
    return { ok: false, reason: `无法进行像素层分析：${check.reason}` };
  }

  // 每 10 秒一帧，保证采样跨越大量不同场景——这是该方法成立的前提。
  const { frames, width, height } = await extractGrayFrames(file, {
    width: 160, height: 90, fps: '1/10', maxFrames: 720,
  });
  const result = detectStaticOverlays(frames, width, height);
  return { ...result, ffmpeg: check.version };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return;
  }

  const args = parseArgs(argv);
  if (!args.file) {
    console.error('缺少待分析的文件路径\n');
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  try {
    await fs.access(args.file);
  } catch {
    console.error(`文件不存在或不可读：${args.file}`);
    process.exitCode = 1;
    return;
  }

  const report = await analyze(args.file, {
    referencePath: args.reference,
    binSec: args.binSec,
    skipHash: !args.hash,
  });

  if (args.overlay) {
    report.overlay = await runOverlayDetection(args.file);
    if (report.overlay.ok && report.overlay.regions.length) {
      report.verdict.reasons.push(
        `画面中检出 ${report.overlay.regions.length} 处静态叠加区域（疑似台标/水印/URL 烧录）`,
      );
      if (report.verdict.level === 'clean') {
        report.verdict.level = 'suspicious';
        report.verdict.label = '存在可疑加工痕迹';
      }
    }
  }

  console.log(renderText(report));

  if (report.overlay) {
    if (!report.overlay.ok) {
      console.log(`像素层分析未执行：${report.overlay.reason}\n`);
    } else if (report.overlay.regions.length === 0) {
      console.log(`像素层分析：采样 ${report.overlay.sampledFrames} 帧，未检出静态叠加区域。\n`);
    } else {
      console.log(`像素层分析（采样 ${report.overlay.sampledFrames} 帧，ffmpeg ${report.overlay.ffmpeg}）：`);
      for (const r of report.overlay.regions) {
        console.log(`  · ${r.position}角 归一化位置 x=${r.rect.x} y=${r.rect.y} `
          + `w=${r.rect.w} h=${r.rect.h}  置信度 ${(r.confidence * 100).toFixed(0)}%`);
      }
      console.log('  （乘以原始分辨率即可得到像素坐标）\n');
    }
  }

  if (args.json) {
    await fs.writeFile(args.json, JSON.stringify(report, null, 2));
    console.log(`机器可读报告已写入：${args.json}\n`);
  }

  // 退出码便于接入批处理：0=干净 1=可疑 2=确认加工
  process.exitCode = { clean: 0, suspicious: 1, tampered: 2, unknown: 1 }[report.verdict.level] ?? 1;
}

main().catch((err) => {
  console.error('分析失败：', err?.stack || err);
  process.exitCode = 3;
});
