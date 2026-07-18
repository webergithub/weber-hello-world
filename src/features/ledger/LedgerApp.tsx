import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { colorFor } from '../../lib/id'
import { toYuan } from '../../lib/settle'
import { shareText } from '../../lib/nativeShare'
import type { Expense } from '../../types'
import { AddExpense } from './AddExpense'
import { settlements, summarize, totalSpent } from './split'

export function LedgerApp() {
  const { activeGroup, dispatch } = useStore()
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<Expense | undefined>()
  const [tab, setTab] = useState<'list' | 'settle'>('list')
  const [shareMsg, setShareMsg] = useState('')

  const summ = useMemo(
    () => (activeGroup ? summarize(activeGroup.members, activeGroup.expenses) : []),
    [activeGroup],
  )
  const transfers = useMemo(() => settlements(summ), [summ])

  if (!activeGroup) {
    return (
      <div className="empty">
        <div className="big">🧾</div>
        <div>请先在「群组」中选择或创建一个群组</div>
      </div>
    )
  }

  const name = (id: string) => activeGroup.members.find((m) => m.id === id)?.nickname ?? '?'
  const total = totalSpent(activeGroup.expenses)

  async function shareBill() {
    const lines = [`【${activeGroup!.name}】AA 账单`, `总支出 ¥${toYuan(total)} · ${activeGroup!.members.length} 人`, '', '各家账单：']
    for (const s of summ) {
      lines.push(`· ${name(s.memberId)}：${s.net >= 0 ? '应收' : '应付'} ¥${toYuan(Math.abs(s.net))}`)
    }
    lines.push('', '转账方案：')
    if (transfers.length === 0) lines.push('· 账目已平，无需转账')
    else for (const t of transfers) lines.push(`· ${name(t.from)} → ${name(t.to)} ¥${toYuan(t.amount)}`)
    lines.push('', '—— TrailMate 出游助手')
    const res = await shareText(`${activeGroup!.name} 账单`, lines.join('\n'))
    setShareMsg(res === 'shared' ? '已打开分享' : res === 'copied' ? '账单已复制到剪贴板' : '分享失败')
    setTimeout(() => setShareMsg(''), 2500)
  }

  return (
    <div>
      <div className="page-head">
        <h1>记账 · {activeGroup.name}</h1>
        <p>
          总支出 ¥{toYuan(total)} · {activeGroup.expenses.length} 笔 · {activeGroup.members.length} 人
        </p>
      </div>

      <div className="seg">
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>消费明细</button>
        <button className={tab === 'settle' ? 'on' : ''} onClick={() => setTab('settle')}>结算账单</button>
      </div>

      {tab === 'list' && (
        <>
          <button className="btn primary block" onClick={() => { setEditing(undefined); setShowAdd(true) }}>
            ＋ 记一笔
          </button>
          {activeGroup.expenses.length === 0 ? (
            <div className="empty">
              <div className="big">💸</div>
              <div>还没有记账，点上方按钮开始</div>
            </div>
          ) : (
            <div className="card" style={{ marginTop: 12 }}>
              {activeGroup.expenses.map((e) => (
                <div key={e.id} className="list-item" onClick={() => { setEditing(e); setShowAdd(true) }}>
                  <div className="avatar" style={{ background: colorFor(e.payerId), width: 32, height: 32, fontSize: 12 }}>
                    {name(e.payerId).slice(0, 1)}
                  </div>
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <strong>{e.title}</strong>
                      {e.receiptImage && <span className="tag">📷</span>}
                      <span className="tag">{e.category}</span>
                    </div>
                    <div className="small muted">
                      {name(e.payerId)} 垫付 · {e.participantIds.length} 人分摊 ·{' '}
                      {e.mode === 'equal' ? '平均' : e.mode === 'shares' ? '按份' : '按额'}
                    </div>
                  </div>
                  <strong>¥{toYuan(e.amountCents)}</strong>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'settle' && (
        <>
          <div className="card">
            <h3>各家账单</h3>
            {summ.map((s) => (
              <div key={s.memberId} className="settle-row">
                <div className="avatar" style={{ background: colorFor(s.memberId), width: 30, height: 30, fontSize: 12 }}>
                  {name(s.memberId).slice(0, 1)}
                </div>
                <div>
                  <div>{name(s.memberId)}</div>
                  <div className="small muted">垫付 ¥{toYuan(s.paid)} · 应摊 ¥{toYuan(s.owed)}</div>
                </div>
                <span className={`amt ${s.net >= 0 ? 'pos' : 'neg'}`}>
                  {s.net >= 0 ? '应收 ' : '应付 '}¥{toYuan(Math.abs(s.net))}
                </span>
              </div>
            ))}
          </div>

          <div className="card">
            <h3>最优转账方案（{transfers.length} 笔）</h3>
            {transfers.length === 0 ? (
              <div className="muted small">账目已平，无需转账。</div>
            ) : (
              transfers.map((t, i) => (
                <div key={i} className="settle-row">
                  <span className="pill" style={{ borderColor: colorFor(t.from) }}>{name(t.from)}</span>
                  <span className="muted">→ 付给 →</span>
                  <span className="pill" style={{ borderColor: colorFor(t.to) }}>{name(t.to)}</span>
                  <span className="amt">¥{toYuan(t.amount)}</span>
                </div>
              ))
            )}
            <p className="small muted" style={{ marginTop: 10 }}>
              已用最少转账笔数算法，家庭/成员间按上表付款即可全部结清。
            </p>
            <button className="btn block" style={{ marginTop: 10 }} onClick={shareBill}>
              📤 分享账单
            </button>
            {shareMsg && <div className="small muted" style={{ marginTop: 6 }}>{shareMsg}</div>}
          </div>
        </>
      )}

      {showAdd && (
        <AddExpense
          group={activeGroup}
          editing={editing}
          onClose={() => setShowAdd(false)}
          onDelete={
            editing
              ? () => {
                  dispatch({ type: 'deleteExpense', groupId: activeGroup.id, expenseId: editing.id })
                  setShowAdd(false)
                }
              : undefined
          }
          onSave={(exp) => {
            if (editing) dispatch({ type: 'updateExpense', groupId: activeGroup.id, expense: exp })
            else dispatch({ type: 'addExpense', groupId: activeGroup.id, expense: exp })
            setShowAdd(false)
          }}
        />
      )}
    </div>
  )
}
