// TrailMate 极简 WebRTC 信令服务器。
//
// 职责：只做「牵线」——把同一个群组(room)内各设备的 SDP / ICE 信令互相转发，
// 帮助它们建立点对点(P2P)的 WebRTC 连接。连接建立后，位置、语音、聊天等
// 业务数据全部走设备之间的 P2P 直连，不经过本服务器（省流量、更私密）。
//
// 运行：node server/signaling.js   （默认端口 8787，可用 PORT 环境变量覆盖）
// 依赖：ws

import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8787)
const wss = new WebSocketServer({ port: PORT })

/** room -> Map<peerId, ws> */
const rooms = new Map()

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
}

function leave(ws) {
  const { room, peerId } = ws.meta || {}
  if (!room) return
  const peers = rooms.get(room)
  if (!peers) return
  peers.delete(peerId)
  for (const other of peers.values()) send(other, { type: 'left', peerId })
  if (peers.size === 0) rooms.delete(room)
}

wss.on('connection', (ws) => {
  ws.meta = {}
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'join') {
      const { room, peerId } = msg
      if (!room || !peerId) return
      ws.meta = { room, peerId }
      if (!rooms.has(room)) rooms.set(room, new Map())
      const peers = rooms.get(room)
      // 告诉新入者：房间里已有哪些人（由新入者主动发起连接，避免双向抢发）
      send(ws, { type: 'peers', peers: [...peers.keys()] })
      // 通知已有成员：来新人了
      for (const other of peers.values()) send(other, { type: 'joined', peerId })
      peers.set(peerId, ws)
      return
    }

    // 定向转发信令：{type:'signal', to, from, data}
    if (msg.type === 'signal') {
      const { room } = ws.meta
      const peers = rooms.get(room)
      const target = peers && peers.get(msg.to)
      if (target) send(target, { type: 'signal', from: msg.from, to: msg.to, data: msg.data })
      return
    }
  })

  ws.on('close', () => leave(ws))
  ws.on('error', () => leave(ws))
})

console.log(`[TrailMate] 信令服务器已启动: ws://0.0.0.0:${PORT}`)
