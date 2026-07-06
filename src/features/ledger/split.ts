// 从一组消费计算每人净额与家庭账单
import { minimizeTransfers, type Balance, type Transfer } from '../../lib/settle'
import type { Expense, Member } from '../../types'

export interface MemberSummary {
  memberId: string
  paid: number // 垫付合计(分)
  owed: number // 应分摊合计(分)
  net: number // paid - owed，正=应收，负=应付
}

// 计算单笔消费中每个参与者应承担的金额(分)，处理余数分配
export function shareOf(exp: Expense): Record<string, number> {
  const ids = exp.participantIds
  const result: Record<string, number> = {}
  if (ids.length === 0) return result

  if (exp.mode === 'exact') {
    for (const id of ids) result[id] = Math.round(exp.weights?.[id] ?? 0)
    return result
  }

  // equal 视为每人权重 1；shares 用自定义权重
  const weights: Record<string, number> = {}
  let totalW = 0
  for (const id of ids) {
    const w = exp.mode === 'shares' ? Math.max(0, exp.weights?.[id] ?? 0) : 1
    weights[id] = w
    totalW += w
  }
  if (totalW === 0) return result

  let allocated = 0
  ids.forEach((id, i) => {
    if (i === ids.length - 1) {
      result[id] = exp.amountCents - allocated // 最后一人吸收余数
    } else {
      const v = Math.round((exp.amountCents * weights[id]) / totalW)
      result[id] = v
      allocated += v
    }
  })
  return result
}

export function summarize(members: Member[], expenses: Expense[]): MemberSummary[] {
  const paid: Record<string, number> = {}
  const owed: Record<string, number> = {}
  for (const m of members) {
    paid[m.id] = 0
    owed[m.id] = 0
  }
  for (const e of expenses) {
    paid[e.payerId] = (paid[e.payerId] ?? 0) + e.amountCents
    const shares = shareOf(e)
    for (const [id, v] of Object.entries(shares)) {
      owed[id] = (owed[id] ?? 0) + v
    }
  }
  return members.map((m) => ({
    memberId: m.id,
    paid: paid[m.id] ?? 0,
    owed: owed[m.id] ?? 0,
    net: (paid[m.id] ?? 0) - (owed[m.id] ?? 0),
  }))
}

export function settlements(summ: MemberSummary[]): Transfer[] {
  const balances: Balance[] = summ.map((s) => ({ memberId: s.memberId, net: s.net }))
  return minimizeTransfers(balances)
}

export function totalSpent(expenses: Expense[]): number {
  return expenses.reduce((a, e) => a + e.amountCents, 0)
}
