// 组群二维码/口令的编解码

export interface JoinPayload {
  code: string
  name: string
}

export function encodeJoin(p: JoinPayload): string {
  const u = new URLSearchParams({ code: p.code, name: p.name })
  return `trailmate://join?${u.toString()}`
}

export function decodeJoin(text: string): JoinPayload | null {
  try {
    // 兼容纯 6 位验证码
    if (/^\d{6}$/.test(text.trim())) return { code: text.trim(), name: '' }
    const q = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
    const u = new URLSearchParams(q)
    const code = u.get('code')
    if (!code) return null
    return { code, name: u.get('name') || '' }
  } catch {
    return null
  }
}
