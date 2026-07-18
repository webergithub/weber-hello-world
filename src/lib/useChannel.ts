import { useEffect, useRef } from 'react'
import { transport, type PeerMessage } from './transport'
import { uid } from './id'

// 订阅某个群组频道，提供发送与接收能力。
export function useChannel(
  groupId: string | null,
  from: string,
  onMessage: (m: PeerMessage) => void,
) {
  const cbRef = useRef(onMessage)
  cbRef.current = onMessage

  useEffect(() => {
    if (!groupId) return
    transport.join(groupId)
    const off = transport.onMessage((m) => cbRef.current(m))
    return () => {
      off()
      transport.leave()
    }
  }, [groupId])

  function send(kind: string, payload: unknown) {
    if (!groupId) return
    const msg: PeerMessage = { id: uid(), from, kind, payload, ts: Date.now() }
    transport.send(msg)
  }

  return { send }
}
