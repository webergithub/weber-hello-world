import { useState } from 'react'
import { uid } from '../../lib/id'
import { toCents, toYuan } from '../../lib/settle'
import type { Expense, Group, SplitMode } from '../../types'
import { ReceiptScanner, type ReceiptResult } from './ReceiptScanner'
import { shareOf } from './split'

const CATEGORIES = ['餐饮', '油费', '住宿', '门票', '采购', '其他']

export function AddExpense({
  group,
  editing,
  onSave,
  onDelete,
  onClose,
}: {
  group: Group
  editing?: Expense
  onSave: (e: Expense) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(editing?.title ?? '')
  const [amount, setAmount] = useState(editing ? String(toYuan(editing.amountCents)) : '')
  const [payerId, setPayerId] = useState(editing?.payerId ?? group.myMemberId)
  const [mode, setMode] = useState<SplitMode>(editing?.mode ?? 'equal')
  const [participants, setParticipants] = useState<string[]>(
    editing?.participantIds ?? group.members.map((m) => m.id),
  )
  const [weights, setWeights] = useState<Record<string, number>>(editing?.weights ?? {})
  const [category, setCategory] = useState(editing?.category ?? '餐饮')
  const [note, setNote] = useState(editing?.note ?? '')
  const [receipt, setReceipt] = useState<string | undefined>(editing?.receiptImage)
  const [scan, setScan] = useState(false)

  const amountCents = toCents(parseFloat(amount) || 0)

  function toggle(id: string) {
    setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  }

  function applyReceipt(r: ReceiptResult) {
    setScan(false)
    setReceipt(r.image)
    if (r.amount) setAmount(String(r.amount))
    if (r.merchant && !title) setTitle(r.merchant)
  }

  function submit() {
    const exp: Expense = {
      id: editing?.id ?? uid('e_'),
      title: title.trim() || category,
      payerId,
      amountCents,
      participantIds: participants,
      mode,
      weights: mode === 'equal' ? undefined : weights,
      category,
      ts: editing?.ts ?? Date.now(),
      note: note.trim() || undefined,
      receiptImage: receipt,
    }
    onSave(exp)
  }

  // 预览分摊
  const preview =
    amountCents > 0 && participants.length > 0
      ? shareOf({
          id: 'preview',
          title,
          payerId,
          amountCents,
          participantIds: participants,
          mode,
          weights,
          ts: 0,
        })
      : {}

  const exactSum = Object.entries(weights)
    .filter(([id]) => participants.includes(id))
    .reduce((a, [, v]) => a + Math.round((v || 0) * 100), 0)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? '编辑消费' : '记一笔'}</h2>

        <button className="btn accent block" onClick={() => setScan(true)} style={{ marginBottom: 14 }}>
          📷 拍照识别小票金额
        </button>

        <label className="field">
          <span>项目</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：午餐 / 高速过路费" />
        </label>

        <div className="row">
          <label className="field grow">
            <span>金额（元）</span>
            <input
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0.00"
            />
          </label>
          <label className="field grow">
            <span>付款人（垫付）</span>
            <select className="input" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
              {group.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nickname}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>分类</span>
          <div className="seg">
            {CATEGORIES.map((c) => (
              <button key={c} className={category === c ? 'on' : ''} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </label>

        <div className="field">
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>分摊方式</span>
          <div className="seg">
            <button className={mode === 'equal' ? 'on' : ''} onClick={() => setMode('equal')}>平均</button>
            <button className={mode === 'shares' ? 'on' : ''} onClick={() => setMode('shares')}>按份数</button>
            <button className={mode === 'exact' ? 'on' : ''} onClick={() => setMode('exact')}>按金额</button>
          </div>
        </div>

        <div className="field">
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
            分摊参与人（{participants.length}）
          </span>
          <div className="row wrap">
            {group.members.map((m) => {
              const on = participants.includes(m.id)
              return (
                <button key={m.id} className={`chk ${on ? 'on' : ''}`} onClick={() => toggle(m.id)} type="button">
                  {on ? '✓ ' : ''}
                  {m.nickname}
                </button>
              )
            })}
          </div>
        </div>

        {mode !== 'equal' && (
          <div className="card" style={{ background: 'var(--bg)' }}>
            {participants.map((id) => {
              const m = group.members.find((x) => x.id === id)!
              return (
                <div key={id} className="row" style={{ marginBottom: 8 }}>
                  <span className="grow">{m.nickname}</span>
                  <input
                    className="input"
                    style={{ width: 110 }}
                    inputMode="decimal"
                    placeholder={mode === 'shares' ? '份数' : '金额'}
                    value={weights[id] ?? ''}
                    onChange={(e) =>
                      setWeights((w) => ({ ...w, [id]: parseFloat(e.target.value) || 0 }))
                    }
                  />
                </div>
              )
            })}
            {mode === 'exact' && (
              <div className={`small ${exactSum === amountCents ? 'pos' : 'neg'}`}>
                指定合计 ¥{toYuan(exactSum)} / 总额 ¥{toYuan(amountCents)}
                {exactSum !== amountCents ? '（需相等）' : ' ✓'}
              </div>
            )}
          </div>
        )}

        {Object.keys(preview).length > 0 && (
          <div className="card" style={{ background: 'var(--bg)' }}>
            <div className="small muted" style={{ marginBottom: 6 }}>每人分摊预览</div>
            {Object.entries(preview).map(([id, v]) => (
              <div key={id} className="row spread small" style={{ padding: '3px 0' }}>
                <span>{group.members.find((m) => m.id === id)?.nickname}</span>
                <span>¥{toYuan(v)}</span>
              </div>
            ))}
          </div>
        )}

        <label className="field">
          <span>备注（可选）</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {receipt && <img className="receipt-preview" src={receipt} alt="小票" />}

        <button
          className="btn primary block"
          disabled={amountCents <= 0 || participants.length === 0 || (mode === 'exact' && exactSum !== amountCents)}
          onClick={submit}
          style={{ marginTop: 8 }}
        >
          保存
        </button>

        {onDelete && (
          <button
            className="btn danger block"
            style={{ marginTop: 10 }}
            onClick={() => {
              if (confirm('删除这笔消费？')) onDelete()
            }}
          >
            删除这笔
          </button>
        )}

        {scan && <ReceiptScanner onResult={applyReceipt} onClose={() => setScan(false)} />}
      </div>
    </div>
  )
}
