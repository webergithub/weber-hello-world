// 备份（G-LG-1）：整个应用状态（群组+成员+账目）的导出/导入。
// 纯函数便于夹具回归；UI 层负责触发下载与文件读取。
import type { AppState, Group } from '../types'

const MAGIC = 'trailmate-backup'
const VERSION = 1

export interface BackupFile {
  magic: string
  version: number
  exportedAt: number
  state: AppState
}

export function exportState(state: AppState, now: number = Date.now()): string {
  const file: BackupFile = { magic: MAGIC, version: VERSION, exportedAt: now, state }
  return JSON.stringify(file, null, 2)
}

// 校验并解析备份 JSON；不合法返回 null（调用方不得改动现有数据）
export function importState(json: string): AppState | null {
  let file: unknown
  try {
    file = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof file !== 'object' || file === null) return null
  const f = file as Partial<BackupFile>
  if (f.magic !== MAGIC || typeof f.version !== 'number' || !f.state) return null
  const s = f.state as Partial<AppState>
  if (!Array.isArray(s.groups)) return null
  for (const g of s.groups as Group[]) {
    if (typeof g.id !== 'string' || typeof g.code !== 'string') return null
    if (!Array.isArray(g.members) || !Array.isArray(g.expenses)) return null
  }
  const activeGroupId =
    typeof s.activeGroupId === 'string' &&
    (s.groups as Group[]).some((g) => g.id === s.activeGroupId)
      ? s.activeGroupId
      : (s.groups as Group[])[0]?.id ?? null
  return { groups: s.groups as Group[], activeGroupId }
}
