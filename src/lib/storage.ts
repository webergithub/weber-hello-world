// 基于 localStorage 的持久化封装（带命名空间与订阅）

const NS = 'trailmate:'

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value))
  } catch {
    // 忽略容量/隐私模式错误
  }
}

export function remove(key: string): void {
  localStorage.removeItem(NS + key)
}
