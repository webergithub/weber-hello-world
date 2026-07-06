// AA 结算核心算法：净额计算 + 最小化转账笔数

export interface Balance {
  memberId: string
  // 正数表示别人欠他（应收），负数表示他欠别人（应付）
  net: number
}

export interface Transfer {
  from: string // 付款方（欠钱的人）
  to: string // 收款方（垫付的人）
  amount: number
}

// 分（整数）为单位避免浮点误差
export function toCents(yuan: number): number {
  return Math.round(yuan * 100)
}
export function toYuan(cents: number): number {
  return Math.round(cents) / 100
}

/**
 * 贪心最小转账：每次让最大债务人还给最大债权人，
 * 保证转账笔数 <= n-1，对出游 AA 场景已足够优。
 */
export function minimizeTransfers(balances: Balance[]): Transfer[] {
  const debtors = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ id: b.memberId, amt: -b.net }))
    .sort((a, b) => b.amt - a.amt)
  const creditors = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ id: b.memberId, amt: b.net }))
    .sort((a, b) => b.amt - a.amt)

  const transfers: Transfer[] = []
  let i = 0
  let j = 0
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt)
    if (pay > 0) {
      transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: pay })
    }
    debtors[i].amt -= pay
    creditors[j].amt -= pay
    if (debtors[i].amt <= 0) i++
    if (creditors[j].amt <= 0) j++
  }
  return transfers
}
