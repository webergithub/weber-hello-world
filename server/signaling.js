// TrailMate 极简 WebRTC 信令服务器。
//
// 职责：只做「牵线」——把同一个群组(room)内各设备的 SDP / ICE 信令互相转发，
// 帮助它们建立点对点(P2P)的 WebRTC 连接。连接建立后，位置、语音、聊天等
// 业务数据全部走设备之间的 P2P 直连，不经过本服务器（省流量、更私密）。
//
// 运行：node server/signaling.js   （默认端口 8787，可用 PORT 环境变量覆盖）
// 依赖：ws
//
// 防护（G-SEC-1）：
//   SIGNAL_TOKEN 环境变量设置后，join 必须携带相同 token，否则断开（4003）。
//   单连接限流 RATE_MAX 条 / RATE_WINDOW_MS，超限断开（4008）。
//   单条消息上限 MAX_MSG_BYTES，超限断开（4002）。
//   单 IP 并发连接上限 MAX_CONN_PER_IP，超限拒绝（4001）。
//   TLS：本进程只监听明文 ws，公网部署必须挂在反向代理（Caddy/Nginx）后走 wss。
//
// 业务帧中继（BR-1.2，哑中继）：
//   {type:'relay-join', room}  room = SHA256('trailmate-room-v1|' + 队伍码) 的十六进制
//   {type:'relay', room, kind, body}  body = base64(端到端密文)
//   服务端只按 room 分房转发，**看不到队伍码、看不懂 kind、无法解密 body**。
//   队伍码绝不上传：它是 PBKDF2 派生密钥的唯一输入，上传即等于交出密钥。

import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8787)
const TOKEN = process.env.SIGNAL_TOKEN || ''
const MAX_MSG_BYTES = 64 * 1024
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 80
const MAX_CONN_PER_IP = 32

const wss = new WebSocketServer({ port: PORT })

/** room -> Map<peerId, ws> */
const rooms = new Map()

/** 中继房间：roomHash -> Set<ws>（BR-1.2）。roomHash 由客户端算，服务端不知队伍码。 */
const relayRooms = new Map()
const ROOM_RE = /^[0-9a-f]{64}$/   // SHA256 十六进制
/** ip -> 并发连接数 */
const ipConns = new Map()

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

function leaveRelay(ws) {
  const r = ws.relayRoom
  if (!r) return
  const peers = relayRooms.get(r)
  if (!peers) return
  peers.delete(ws)
  if (peers.size === 0) relayRooms.delete(r)
  ws.relayRoom = null
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown'
  const n = (ipConns.get(ip) || 0) + 1
  if (n > MAX_CONN_PER_IP) {
    ws.close(4001, 'too many connections')
    return
  }
  ipConns.set(ip, n)

  ws.meta = {}
  ws.rate = { start: Date.now(), count: 0 }

  ws.on('message', (raw) => {
    if (raw.length > MAX_MSG_BYTES) {
      ws.close(4002, 'message too large')
      return
    }
    const now = Date.now()
    if (now - ws.rate.start > RATE_WINDOW_MS) {
      ws.rate.start = now
      ws.rate.count = 0
    }
    if (++ws.rate.count > RATE_MAX) {
      ws.close(4008, 'rate limited')
      return
    }

    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'join') {
      if (TOKEN && msg.token !== TOKEN) {
        ws.close(4003, 'bad token')
        return
      }
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

    // 业务帧中继（BR-1.2）：按「房间哈希」分房转发密文。
    // 安全关键：客户端发来的 room 是 SHA256(trailmate-room-v1|队伍码)，**不是队伍码本身**——
    // 队伍码是端到端加密密钥的唯一输入，一旦上传服务端即可自行派生密钥解密，哑中继将破功。
    // 服务端因此只看得见：房间哈希、kind 字节、密文。既不理解也无法还原业务内容。
    if (msg.type === 'relay') {
      const { room, kind, body } = msg
      if (typeof room !== 'string' || !ROOM_RE.test(room)) return
      if (!Number.isInteger(kind) || kind < 0 || kind > 255) return
      if (typeof body !== 'string' || body.length > MAX_MSG_BYTES) return
      // 必须已通过 relay-join（含 token 校验）且只能发往自己所在房间——
      // 否则任何知道房间哈希的连接都能无凭据注入帧。
      if (ws.relayRoom !== room) return
      const peers = relayRooms.get(room)
      if (!peers || !peers.has(ws)) return
      for (const other of peers) {
        if (other !== ws) send(other, { type: 'relay', kind, body })
      }
      return
    }

    // 加入中继房间：只上报房间哈希，不上报队伍码
    if (msg.type === 'relay-join') {
      const { room } = msg
      if (typeof room !== 'string' || !ROOM_RE.test(room)) return
      if (TOKEN && msg.token !== TOKEN) {
        ws.close(4003, 'bad token')
        return
      }
      leaveRelay(ws)
      ws.relayRoom = room
      if (!relayRooms.has(room)) relayRooms.set(room, new Set())
      relayRooms.get(room).add(ws)
      send(ws, { type: 'relay-joined', peers: relayRooms.get(room).size - 1 })
      return
    }

    // 未通过 join（含 token 校验）的连接不允许转发
    if (!ws.meta.room) return

    // 定向转发信令：{type:'signal', to, from, data}
    if (msg.type === 'signal') {
      const peers = rooms.get(ws.meta.room)
      const target = peers && peers.get(msg.to)
      if (target) send(target, { type: 'signal', from: msg.from, to: msg.to, data: msg.data })
      return
    }
  })

  const cleanup = () => {
    leave(ws)
    leaveRelay(ws)
    const left = (ipConns.get(ip) || 1) - 1
    if (left <= 0) ipConns.delete(ip)
    else ipConns.set(ip, left)
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
})

console.log(
  `[TrailMate] 信令服务器已启动: ws://0.0.0.0:${PORT}` +
    (TOKEN ? ' （已启用 token 鉴权）' : ' （未设 SIGNAL_TOKEN，任意连接可加入——仅限内网/开发）'),
)
