// 轻量 ID 与验证码生成工具

export function uid(prefix = ''): string {
  const rnd = crypto.getRandomValues(new Uint32Array(2))
  return `${prefix}${rnd[0].toString(36)}${rnd[1].toString(36)}`
}

// 6 位验证码，用于面对面组群。
// 与原生队伍码同一字符集（去易混字符，G-PF-1 码空间统一），跨端观感一致。
export function joinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const rnd = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(rnd, (b) => chars[b % chars.length]).join('')
}

// 为成员生成稳定的展示颜色
export function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} 70% 50%)`
}
