// 全局领域模型

export interface Member {
  id: string
  nickname: string
  isMe?: boolean
}

// 记账：一笔消费
export type SplitMode = 'equal' | 'shares' | 'exact'

export interface Expense {
  id: string
  title: string
  payerId: string // 垫付人
  amountCents: number
  // 分摊参与人；exact/shares 模式下用 weights 指定
  participantIds: string[]
  mode: SplitMode
  // shares: 份数权重；exact: 精确金额(分)。key = memberId
  weights?: Record<string, number>
  category?: string
  ts: number
  note?: string
  receiptImage?: string // dataURL，拍照小票
}

// 群组：可保存多个，后续继续使用
export interface Group {
  id: string
  name: string
  code: string // 6 位加入验证码
  createdAt: number
  myMemberId: string
  members: Member[]
  expenses: Expense[]
}

export interface AppState {
  groups: Group[]
  activeGroupId: string | null
}
