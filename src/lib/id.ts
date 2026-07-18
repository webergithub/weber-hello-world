// 轻量 ID 与验证码生成工具

export function uid(prefix = ''): string {
  const rnd = crypto.getRandomValues(new Uint32Array(2))
  return `${prefix}${rnd[0].toString(36)}${rnd[1].toString(36)}`
}

// 6 位数字验证码，用于面对面组群
export function joinCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return n.toString().padStart(6, '0')
}

// 为成员生成稳定的展示颜色
export function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} 70% 50%)`
}
