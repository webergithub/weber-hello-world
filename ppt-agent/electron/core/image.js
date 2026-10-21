'use strict';
// 图片平均亮度（用于背景图片的黑白底判断），纯 JS 解码 PNG / JPEG。
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }

function meanLum(data, width, height, channels) {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  let sum = 0, n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const a = channels === 4 ? data[i + 3] / 255 : 1;
      const l = 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
      sum += l * a + (1 - a); // 透明区域按白色计
      n++;
    }
  }
  return n ? sum / n : null;
}

async function imageLuminance(buf, name = '') {
  if (!buf || !buf.length) return null;
  const n = name.toLowerCase();
  if (buf[0] === 0x89 && buf[1] === 0x50 || n.endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return meanLum(png.data, png.width, png.height, 4);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 || /\.jpe?g$/.test(n)) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 80, maxMemoryUsageInMB: 512 });
    return meanLum(img.data, img.width, img.height, 4);
  }
  return null;
}

module.exports = { imageLuminance };
