package cc.trailmate.app

import android.os.Handler
import android.os.Looper
import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 网络中继通道（BR-1.1）：与 BLE 并行的第二条传输路，补上"超 BLE 距离即失效"（G-NET-1）。
 *
 * 只发密文：上行的是 `roomId(队伍码)` + `kind` + base64(端到端密文)，**队伍码绝不上传**
 * （见 server/signaling.js 与《④ 后台服务端规划》§3.3）。收端用自己的队伍码解密，MAC 不过即丢。
 *
 * 鲁棒性（BR-1.4）：连接失败/断线只做指数退避重连，绝不抛错、绝不阻塞 UI；
 * relayUrl 为空即完全不启用——此时行为与今日纯 BLE 版一致。
 */
class NetTransport(
    private val url: String,
    private val room: String,
    private val token: String,
    private val onFrame: (Byte, ByteArray) -> Unit,   // 收到中继帧：kind + 密文
    private val onCloud: (Int) -> Unit,                // 云端在线数变化（BR-1.5）
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var closed = false
    private var backoff = 1000L
    @Volatile var cloudCount = 0
        private set

    fun start() { closed = false; connect() }

    fun stop() {
        closed = true
        runCatching { ws?.close(1000, null) }
        ws = null
        setCloud(0)
    }

    fun relay(kind: Byte, sealed: ByteArray) {
        val w = ws ?: return
        val msg = JSONObject()
            .put("type", "relay").put("room", room)
            .put("kind", kind.toInt() and 0xFF)
            .put("body", Base64.encodeToString(sealed, Base64.NO_WRAP))
        runCatching { w.send(msg.toString()) }
    }

    private fun setCloud(n: Int) {
        cloudCount = n
        main.post { onCloud(n) }
    }

    private fun connect() {
        if (closed) return
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoff = 1000L
                val join = JSONObject().put("type", "relay-join").put("room", room)
                if (token.isNotEmpty()) join.put("token", token)
                runCatching { webSocket.send(join.toString()) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val o = JSONObject(text)
                    when (o.optString("type")) {
                        "relay-joined" -> setCloud(o.optInt("peers", 0))
                        "relay" -> {
                            val kind = (o.getInt("kind") and 0xFF).toByte()
                            val sealed = Base64.decode(o.getString("body"), Base64.DEFAULT)
                            main.post { onFrame(kind, sealed) }
                        }
                    }
                } catch (_: Exception) {}
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = scheduleReconnect()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = scheduleReconnect()
        })
    }

    private fun scheduleReconnect() {
        setCloud(0)
        if (closed) return
        main.postDelayed({ connect() }, backoff)
        backoff = (backoff * 2).coerceAtMost(16000L)
    }
}
