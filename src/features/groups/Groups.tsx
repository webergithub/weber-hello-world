import { useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useStore } from '../../store'
import { colorFor } from '../../lib/id'
import { encodeJoin, decodeJoin } from '../../lib/joinlink'
import { exportState, importState } from '../../lib/backup'
import { QrScanner } from '../../components/QrScanner'
import type { Group } from '../../types'

export function Groups() {
  const { state, dispatch, activeGroup } = useStore()
  const [mode, setMode] = useState<null | 'create' | 'join'>(null)
  const [scan, setScan] = useState(false)
  const [detail, setDetail] = useState<Group | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 备份（G-LG-1）：导出下载 .json；导入选文件校验后整体还原
  const doExport = () => {
    const blob = new Blob([exportState(state)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trailmate-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  const doImport = async (file: File) => {
    const text = await file.text()
    const next = importState(text)
    if (next) dispatch({ type: 'importState', state: next })
    else alert('导入失败：不是有效的 TrailMate 备份文件，当前数据未改动。')
  }

  return (
    <div>
      <div className="page-head">
        <h1>我的群组</h1>
        <p>面对面创建或加入，群组会自动保存，下次出游继续使用。</p>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn primary grow" onClick={() => setMode('create')}>
          ＋ 创建群组
        </button>
        <button className="btn grow" onClick={() => setMode('join')}>
          加入群组
        </button>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn sm grow" onClick={doExport}>
          ⬇️ 导出备份
        </button>
        <button className="btn sm grow" onClick={() => fileRef.current?.click()}>
          ⬆️ 导入备份
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void doImport(f)
            e.target.value = ''
          }}
        />
      </div>

      {state.groups.length === 0 ? (
        <div className="empty">
          <div className="big">👥</div>
          <div>还没有群组</div>
          <p className="small">创建一个群组，邀请同行的朋友加入吧。</p>
        </div>
      ) : (
        <div className="card">
          <h3>已保存的群组（{state.groups.length}）</h3>
          {state.groups.map((g) => {
            const active = g.id === activeGroup?.id
            return (
              <div key={g.id} className="list-item">
                <div className="avatar" style={{ background: colorFor(g.id) }}>
                  {g.name.slice(0, 1)}
                </div>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{g.name}</strong>
                    {active && <span className="badge">当前</span>}
                  </div>
                  <div className="small muted">
                    验证码 {g.code} · {g.members.length} 人 · {g.expenses.length} 笔账
                  </div>
                </div>
                <button className="btn sm" onClick={() => setDetail(g)}>
                  管理
                </button>
                {!active && (
                  <button
                    className="btn sm primary"
                    onClick={() => dispatch({ type: 'setActive', groupId: g.id })}
                  >
                    切换
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {mode === 'create' && (
        <CreateModal
          onClose={() => setMode(null)}
          onSubmit={(name, nickname) => {
            dispatch({ type: 'createGroup', name, nickname })
            setMode(null)
          }}
        />
      )}
      {mode === 'join' && (
        <JoinModal
          onClose={() => setMode(null)}
          onScan={() => {
            setMode(null)
            setScan(true)
          }}
          onSubmit={(name, code, nickname) => {
            dispatch({ type: 'joinGroup', name, code, nickname })
            setMode(null)
          }}
        />
      )}
      {scan && (
        <QrScanner
          onClose={() => setScan(false)}
          onResult={(text) => {
            setScan(false)
            const p = decodeJoin(text)
            if (p) setMode('join'), setPrefill(p)
          }}
        />
      )}
      {detail && <GroupDetail group={detail} onClose={() => setDetail(null)} />}
    </div>
  )

  // 扫码后回填加入表单
  function setPrefill(p: { code: string; name: string }) {
    ;(window as unknown as { __prefill?: unknown }).__prefill = p
  }
}

function CreateModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (name: string, nickname: string) => void
}) {
  const [name, setName] = useState('')
  const [nickname, setNickname] = useState('')
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>创建群组</h2>
        <label className="field">
          <span>群组名称（如：五一露营）</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="给这次出游起个名字" />
        </label>
        <label className="field">
          <span>我的昵称</span>
          <input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="朋友看到的名字" />
        </label>
        <button
          className="btn primary block"
          disabled={!name.trim()}
          onClick={() => onSubmit(name.trim(), nickname.trim())}
        >
          创建并保存
        </button>
      </div>
    </div>
  )
}

function JoinModal({
  onClose,
  onScan,
  onSubmit,
}: {
  onClose: () => void
  onScan: () => void
  onSubmit: (name: string, code: string, nickname: string) => void
}) {
  const prefill = (window as unknown as { __prefill?: { code: string; name: string } }).__prefill
  const [name, setName] = useState(prefill?.name ?? '')
  const [code, setCode] = useState(prefill?.code ?? '')
  const [nickname, setNickname] = useState('')
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>加入群组</h2>
        <button className="btn block" onClick={onScan} style={{ marginBottom: 14 }}>
          📷 扫描二维码
        </button>
        <div className="row" style={{ margin: '0 0 12px' }}>
          <hr className="hr grow" />
          <span className="small muted">或输入验证码</span>
          <hr className="hr grow" />
        </div>
        <label className="field">
          <span>6 位验证码</span>
          <input
            className="input"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="向群主索取"
          />
        </label>
        <label className="field">
          <span>群组名称</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="露营群" />
        </label>
        <label className="field">
          <span>我的昵称</span>
          <input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="你的名字" />
        </label>
        <button
          className="btn primary block"
          disabled={code.length !== 6}
          onClick={() => {
            onSubmit(name.trim() || '露营群', code, nickname.trim())
            ;(window as unknown as { __prefill?: unknown }).__prefill = undefined
          }}
        >
          加入并保存
        </button>
      </div>
    </div>
  )
}

function GroupDetail({ group, onClose }: { group: Group; onClose: () => void }) {
  const { dispatch } = useStore()
  const [name, setName] = useState(group.name)
  const [newMember, setNewMember] = useState('')
  const me = group.members.find((m) => m.id === group.myMemberId)
  const [myName, setMyName] = useState(me?.nickname ?? '')

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>群组管理</h2>

        <div className="card" style={{ textAlign: 'center' }}>
          <div className="small muted" style={{ marginBottom: 8 }}>面对面加入 · 出示给朋友扫描</div>
          <div style={{ background: '#fff', display: 'inline-block', padding: 12, borderRadius: 12 }}>
            <QRCodeSVG value={encodeJoin({ code: group.code, name: group.name })} size={168} />
          </div>
          <div className="code-box" style={{ marginTop: 12 }}>{group.code}</div>
        </div>

        <label className="field">
          <span>群组名称</span>
          <div className="row">
            <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn sm" onClick={() => dispatch({ type: 'renameGroup', groupId: group.id, name: name.trim() || group.name })}>
              保存
            </button>
          </div>
        </label>

        <label className="field">
          <span>我的昵称</span>
          <div className="row">
            <input className="input grow" value={myName} onChange={(e) => setMyName(e.target.value)} />
            <button className="btn sm" onClick={() => dispatch({ type: 'renameMe', groupId: group.id, nickname: myName.trim() || '我' })}>
              保存
            </button>
          </div>
        </label>

        <h3 style={{ marginTop: 6 }}>成员（{group.members.length}）</h3>
        {group.members.map((m) => (
          <div key={m.id} className="list-item">
            <div className="avatar" style={{ background: colorFor(m.id), width: 30, height: 30, fontSize: 12 }}>
              {m.nickname.slice(0, 1)}
            </div>
            <span>{m.nickname}</span>
            {m.isMe && <span className="tag">我</span>}
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="input grow"
            value={newMember}
            placeholder="添加线下同行成员"
            onChange={(e) => setNewMember(e.target.value)}
          />
          <button
            className="btn sm primary"
            disabled={!newMember.trim()}
            onClick={() => {
              dispatch({ type: 'addMember', groupId: group.id, nickname: newMember.trim() })
              setNewMember('')
            }}
          >
            添加
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          提示：记账分摊需要每位家庭/成员在此登记，方便核算各家账单。
        </p>

        <hr className="hr" />
        <button
          className="btn danger block"
          onClick={() => {
            if (confirm(`删除群组「${group.name}」及其账目？此操作不可恢复。`)) {
              dispatch({ type: 'deleteGroup', groupId: group.id })
              onClose()
            }
          }}
        >
          删除群组
        </button>
      </div>
    </div>
  )
}
