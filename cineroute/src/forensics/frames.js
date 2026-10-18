/**
 * 帧级分析 —— 纯 JS，输入是裸灰度帧（每像素 1 字节）。
 *
 * 刻意让 ffmpeg 只干"解码 + 缩放 + 转灰度"这一件所有构建都支持的事，
 * 分析全部留在这里。好处有二：不引入任何图像解码依赖；
 * 分析逻辑可以脱离 ffmpeg 单独测试（喂合成帧即可）。
 *
 * 两项能力：
 *  1) **感知哈希（pHash）**：内容指纹。对重编码、改码率、改分辨率稳健，
 *     用于回答"这是不是同一部作品"以及"这一段对应母版的哪一段"。
 *  2) **静态叠加物检测**：台标、水印、站点 URL 烧录进画面后，会在**跨场景**
 *     的时间维度上保持像素不变。对跨越整片采样的一组帧计算逐像素时间方差，
 *     方差近零的连通区域就是叠加物候选——正片内容不可能在几十个不同场景里
 *     保持同一块像素恒定。
 */

/* ────────────────────────── 感知哈希 ────────────────────────── */

/** 预计算 DCT-II 余弦系数表（N 固定时只算一次）。 */
const dctTables = new Map();
function dctTable(N) {
  if (!dctTables.has(N)) {
    const t = new Float64Array(N * N);
    for (let k = 0; k < N; k += 1) {
      for (let n = 0; n < N; n += 1) {
        t[k * N + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
      }
    }
    dctTables.set(N, t);
  }
  return dctTables.get(N);
}

/**
 * 二维 DCT-II（行列分离，O(N³)，N=32 时可忽略）。
 * @param {number[]|Uint8Array} pixels 长度 N*N
 * @param {number} N
 * @returns {Float64Array}
 */
export function dct2d(pixels, N) {
  const t = dctTable(N);
  const rows = new Float64Array(N * N);

  for (let y = 0; y < N; y += 1) {
    for (let k = 0; k < N; k += 1) {
      let sum = 0;
      for (let x = 0; x < N; x += 1) sum += pixels[y * N + x] * t[k * N + x];
      rows[y * N + k] = sum;
    }
  }

  const out = new Float64Array(N * N);
  for (let k = 0; k < N; k += 1) {
    for (let u = 0; u < N; u += 1) {
      let sum = 0;
      for (let y = 0; y < N; y += 1) sum += rows[y * N + u] * t[k * N + y];
      out[k * N + u] = sum;
    }
  }
  return out;
}

/**
 * 计算 64 位 pHash。取 DCT 左上 8×8 低频区（丢弃 DC 分量），
 * 以中位数为阈值二值化——中位数阈值使哈希对整体亮度变化免疫。
 *
 * @param {Uint8Array} gray 32×32 灰度帧
 * @param {number} [size=32]
 * @returns {bigint}
 */
export function pHash(gray, size = 32) {
  const coeffs = dct2d(gray, size);
  const vals = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x === 0 && y === 0) continue;      // 丢弃 DC
      vals.push(coeffs[y * size + x]);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];

  let hash = 0n;
  // 固定 64 位：63 个 AC 系数 + 1 个补位，保证长度稳定
  for (let i = 0; i < 64; i += 1) {
    const v = i < vals.length ? vals[i] : med;
    hash = (hash << 1n) | (v > med ? 1n : 0n);
  }
  return hash;
}

/** 汉明距离（0..64）。距离 ≤10 通常认为是同一画面。 */
export function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

/**
 * 把两条 pHash 序列做逐项最佳匹配，返回相似度与匹配率。
 * 用于"嫌疑副本的每一秒能否在母版里找到对应画面"。
 *
 * @param {bigint[]} suspect
 * @param {bigint[]} reference
 * @param {{threshold?: number}} [opts]
 */
export function matchHashSequences(suspect, reference, opts = {}) {
  const threshold = opts.threshold ?? 10;
  const matches = suspect.map((h, i) => {
    let best = 64;
    let at = -1;
    for (let j = 0; j < reference.length; j += 1) {
      const d = hammingDistance(h, reference[j]);
      if (d < best) { best = d; at = j; }
      if (best === 0) break;
    }
    return { index: i, distance: best, refIndex: at, matched: best <= threshold };
  });

  const matchedCount = matches.filter((m) => m.matched).length;
  return {
    matches,
    matchRate: suspect.length ? matchedCount / suspect.length : 0,
    // 匹配不上的帧就是母版里不存在的画面 —— 插入内容的直接证据
    unmatchedIndices: matches.filter((m) => !m.matched).map((m) => m.index),
  };
}

/* ─────────────────────── 静态叠加物检测 ─────────────────────── */

/**
 * 逐像素时间方差。
 * @param {Uint8Array[]} frames 等尺寸灰度帧
 * @param {number} width @param {number} height
 * @returns {Float64Array}
 */
export function temporalVariance(frames, width, height) {
  const n = frames.length;
  const size = width * height;
  const variance = new Float64Array(size);
  if (n < 2) return variance;

  for (let p = 0; p < size; p += 1) {
    let sum = 0;
    for (let f = 0; f < n; f += 1) sum += frames[f][p];
    const mean = sum / n;
    let acc = 0;
    for (let f = 0; f < n; f += 1) {
      const d = frames[f][p] - mean;
      acc += d * d;
    }
    variance[p] = acc / n;
  }
  return variance;
}

/**
 * 在低方差掩膜上找连通区域（4 邻域，迭代式洪泛，避免递归爆栈）。
 * @param {Uint8Array} mask 1=命中
 * @param {number} width @param {number} height
 * @returns {Array<{x:number,y:number,w:number,h:number,pixels:number}>}
 */
export function connectedRegions(mask, width, height) {
  const seen = new Uint8Array(width * height);
  const regions = [];
  const stack = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;

    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let pixels = 0;

    stack.push(start);
    seen[start] = 1;

    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p - x) / width;
      pixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < width - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - width] && !seen[p - width]) { seen[p - width] = 1; stack.push(p - width); }
      if (y < height - 1 && mask[p + width] && !seen[p + width]) { seen[p + width] = 1; stack.push(p + width); }
    }

    regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels });
  }

  return regions;
}

/**
 * 静态叠加物（台标 / 水印 / 烧录 URL）检测。
 *
 * 输入必须是**跨越整片、覆盖多个场景**的采样帧；只在同一场景内采样会把
 * 静止的背景也判成叠加物。
 *
 * @param {Uint8Array[]} frames
 * @param {number} width @param {number} height
 * @param {{varianceThreshold?:number, minPixelRatio?:number, maxPixelRatio?:number}} [opts]
 */
export function detectStaticOverlays(frames, width, height, opts = {}) {
  const {
    varianceThreshold = 12,     // 灰度方差，低于此视为"几乎不变"
    minPixelRatio = 0.0008,     // 太小的区域是噪点
    maxPixelRatio = 0.25,       // 太大的区域更可能是黑边或静止场景
  } = opts;

  if (frames.length < 4) {
    return { ok: false, reason: '采样帧不足（至少需要 4 帧且应跨越多个场景）', regions: [] };
  }

  const variance = temporalVariance(frames, width, height);
  const mask = new Uint8Array(variance.length);
  for (let i = 0; i < variance.length; i += 1) mask[i] = variance[i] < varianceThreshold ? 1 : 0;

  const total = width * height;
  const regions = connectedRegions(mask, width, height)
    .filter((r) => r.pixels >= total * minPixelRatio && r.pixels <= total * maxPixelRatio)
    // 排除贴满整行/整列的区域：那是信箱黑边，不是叠加物
    .filter((r) => !(r.w >= width * 0.95 && r.y < height * 0.15))
    .filter((r) => !(r.w >= width * 0.95 && r.y + r.h > height * 0.85))
    .map((r) => {
      const cx = (r.x + r.w / 2) / width;
      const cy = (r.y + r.h / 2) / height;
      const corner = `${cy < 0.5 ? '上' : '下'}${cx < 0.5 ? '左' : '右'}`;
      return {
        ...r,
        // 归一化坐标，便于换算回原始分辨率
        rect: {
          x: Number((r.x / width).toFixed(3)),
          y: Number((r.y / height).toFixed(3)),
          w: Number((r.w / width).toFixed(3)),
          h: Number((r.h / height).toFixed(3)),
        },
        position: corner,
        // 角落里的小块最像台标/水印
        confidence: (cx < 0.25 || cx > 0.75) && (cy < 0.25 || cy > 0.75) ? 0.8 : 0.5,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || b.pixels - a.pixels);

  return { ok: true, regions, sampledFrames: frames.length };
}
