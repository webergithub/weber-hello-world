// 忠实移植 VoiceFragment.kt 的 pitchPreserve，验证这段"从未真正跑过"的 DSP：
//  ① 输出长度 == 输入长度  ② 无 NaN、值在 int16 范围  ③ 主频确实 ×f（真的变调了）
export const SR = 44100

export function pitchPreserve(src, f) {          // src: Int16Array，返回 Int16Array（WSOLA 保时长变调）
  if (f === 1.0) return src
  const shifted = new Int16Array(Math.trunc(src.length / f))
  for (let i = 0; i < shifted.length; i++) {
    const pos = i * f
    const i0 = Math.min(Math.trunc(pos), src.length - 1)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const t = pos - i0
    shifted[i] = Math.trunc(src[i0] * (1 - t) + src[i1] * t)
  }
  const frame = 1024, hs = frame / 2, seek = 200, ha = Math.max(hs / f, 1.0)
  const outLen = src.length
  const acc = new Float64Array(outLen + frame)
  const norm = new Float64Array(outLen + frame)
  const win = Array.from({ length: frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1)))
  const place = (outPos, inPos) => {
    for (let j = 0; j < frame; j++) { acc[outPos + j] += shifted[inPos + j] * win[j]; norm[outPos + j] += win[j] }
  }
  place(0, 0)
  let prevInPos = 0, outPos = hs, k = 1
  while (outPos + frame < acc.length) {
    const nominal = Math.trunc(k * ha)
    const refStart = prevInPos + hs                 // 前一帧自然延续处
    if (refStart + frame >= shifted.length) break
    // WSOLA：在 nominal±seek 内找与自然延续相位最匹配的输入位置，消除帧间不连续
    let bestDelta = 0, bestCorr = -Infinity
    for (let delta = -seek; delta <= seek; delta++) {
      const inPos = nominal + delta
      if (inPos < 0 || inPos + frame >= shifted.length) continue
      let corr = 0
      for (let j = 0; j < frame; j += 4) corr += shifted[inPos + j] * shifted[refStart + j]
      if (corr > bestCorr) { bestCorr = corr; bestDelta = delta }
    }
    const inPos = nominal + bestDelta
    if (inPos < 0 || inPos + frame >= shifted.length) break
    place(outPos, inPos)
    prevInPos = inPos; outPos += hs; k++
  }
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    out[i] = norm[i] > 1e-6 ? Math.max(-32768, Math.min(32767, Math.trunc(acc[i] / norm[i]))) : 0
  }
  return out
}

// 估计主频：自相关（对 OLA 相位涂抹稳健，取中段避免起止渐变）
export function dominantHz(x) {
  const a = 4000, b = Math.min(x.length, a + 8192)
  const seg = x.subarray(a, b), N = seg.length
  const minLag = Math.trunc(SR / 800), maxLag = Math.trunc(SR / 80) // 80–800Hz
  let bestLag = minLag, best = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < N; i++) s += seg[i] * seg[i + lag]
    if (s > best) { best = s; bestLag = lag }
  }
  return SR / bestLag
}

