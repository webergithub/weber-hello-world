package cc.trailmate.app

import android.annotation.SuppressLint
import android.content.Context
import java.util.UUID
import kotlin.random.Random

/** 本机身份：稳定设备 ID + 昵称 + 队伍码（与 iOS 版语义一致，默认 public 公共队）。 */
object Identity {
    private const val SP = "trailmate"

    fun deviceId(ctx: Context): String {
        val sp = ctx.getSharedPreferences(SP, Context.MODE_PRIVATE)
        sp.getString("deviceId", null)?.let { return it }
        val id = UUID.randomUUID().toString()
        sp.edit().putString("deviceId", id).apply()
        return id
    }

    fun nick(ctx: Context): String {
        val sp = ctx.getSharedPreferences(SP, Context.MODE_PRIVATE)
        sp.getString("nick", null)?.takeIf { it.isNotEmpty() }?.let { return it }
        val n = "旅友%03d".format(Random.nextInt(1000))
        sp.edit().putString("nick", n).apply()
        return n
    }

    fun setNick(ctx: Context, n: String) {
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).edit().putString("nick", n).apply()
    }

    fun team(ctx: Context): String =
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).getString("team", "public") ?: "public"

    fun setTeam(ctx: Context, code: String) {
        val v = code.trim().ifEmpty { "public" }
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).edit().putString("team", v).apply()
    }

    // 新队伍码：6 位大写字母数字，去掉易混字符（与 iOS newTeamCode 同字符集）
    fun newTeamCode(): String {
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return (1..6).map { chars[Random.nextInt(chars.length)] }.joinToString("")
    }

    // 隐身（G-DR-3）：开启后不向同伴广播自己的位置
    fun ghost(ctx: Context): Boolean =
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).getBoolean("ghost", false)

    fun setGhost(ctx: Context, v: Boolean) {
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).edit().putBoolean("ghost", v).apply()
    }

    // 网络中继（BR-1.1）：relayUrl 为空 = 只用蓝牙（默认，等同今日行为）。token 对应服务端 SIGNAL_TOKEN。
    fun relayUrl(ctx: Context): String =
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).getString("relayUrl", "") ?: ""

    fun setRelayUrl(ctx: Context, url: String) {
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).edit().putString("relayUrl", url.trim()).apply()
    }

    fun relayToken(ctx: Context): String =
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).getString("relayToken", "") ?: ""

    fun setRelayToken(ctx: Context, t: String) {
        ctx.getSharedPreferences(SP, Context.MODE_PRIVATE).edit().putString("relayToken", t.trim()).apply()
    }
}

/**
 * 共享蓝牙 Mesh 总线：全 App 单套 BLE，按「消息类型」路由，按「队伍码」过滤。
 * 帧格式与 iOS 版 MeshBus.swift 完全一致：[kind(1)][teamLen(1)][team][payload]，
 * 因此 Android 原生 ↔ iOS 原生 可跨平台互聊 / 互见位置（同队伍码时）。
 */
@SuppressLint("StaticFieldLeak")
object MeshBus : BleMesh.Listener {
    const val KIND_CHAT: Byte = 1
    const val KIND_LOC: Byte = 2
    const val KIND_VOICE: Byte = 3   // 短语音（G-CM-1）：[u16 jsonLen][json{mid,n,d,ts}][m4a 字节]
    const val KIND_ACK: Byte = 4     // 送达回执（G-CM-2）：json{mid,by}，收到聊天/语音后回发

    private var appCtx: Context? = null
    private var mesh: BleMesh? = null
    private var net: NetTransport? = null
    // 每类型单 handler：后注册者替换前者。Fragment 切 Tab 重建时新实例自动顶替旧实例，
    // 避免向单例累积 lambda 造成旧 Fragment 泄漏与消息重复处理。
    private val handlers = HashMap<Byte, (ByteArray) -> Unit>()
    private val peerHandlers = HashMap<String, (Int) -> Unit>()
    private val cloudHandlers = HashMap<String, (Int) -> Unit>()
    var peerCount = 0
        private set
    var cloudCount = 0    // 云端在线数（BR-1.5：与蓝牙邻居分开显示，不混淆）
        private set

    /** 幂等启动（需已授蓝牙权限）。返回是否成功开启。 */
    fun start(ctx: Context): Boolean {
        val app = ctx.applicationContext
        appCtx = app
        val m = mesh ?: BleMesh(app).also { it.listener = this; mesh = it }
        val ok = m.start()
        startNet(app)   // 网络中继与 BLE 并行（BR-1.1）；relayUrl 为空则空转
        return ok
    }

    // 启动/重启网络通道。队伍码变化或首次配置 URL 时调用。
    fun startNet(ctx: Context) {
        val app = ctx.applicationContext
        appCtx = app
        net?.stop(); net = null
        cloudCount = 0
        val url = Identity.relayUrl(app)
        if (url.isEmpty()) { cloudHandlers.values.forEach { it(0) }; return }
        net = NetTransport(
            url = url,
            room = MeshCrypto.roomId(Identity.team(app)),
            token = Identity.relayToken(app),
            onFrame = { kind, sealed -> dispatchSealed(kind, sealed) },   // 网络收帧：用本机队伍码解密
            onCloud = { n -> cloudCount = n; cloudHandlers.values.forEach { it(n) } },
        ).also { it.start() }
    }

    fun send(kind: Byte, payload: ByteArray) {
        val ctx = appCtx ?: return
        val teamStr = Identity.team(ctx)
        // 端到端加密（G-CM-3）：信封 team 明文仅供 BLE 分房，业务负载全密文
        val sealed = MeshCrypto.encrypt(teamStr, payload)
        // BLE 通道：完整信封帧
        val team = teamStr.toByteArray(Charsets.UTF_8).let {
            if (it.size > 32) it.copyOfRange(0, 32) else it
        }
        val frame = ByteArray(2 + team.size + sealed.size)
        frame[0] = kind
        frame[1] = team.size.toByte()
        System.arraycopy(team, 0, frame, 2, team.size)
        System.arraycopy(sealed, 0, frame, 2 + team.size, sealed.size)
        mesh?.send(frame)
        // 网络通道：只发 roomId + kind + 密文，**队伍码不上网**（BR-1.2）
        net?.relay(kind, sealed)
    }

    fun subscribe(kind: Byte, handler: (ByteArray) -> Unit) {
        handlers[kind] = handler
    }

    fun onPeers(tag: String, handler: (Int) -> Unit) {
        peerHandlers[tag] = handler
        handler(peerCount)
    }

    fun onCloud(tag: String, handler: (Int) -> Unit) {
        cloudHandlers[tag] = handler
        handler(cloudCount)
    }

    // 解密并分发（两条通道共用）。BR-1.3 双通道去重：业务层已幂等——
    // 聊天/语音按 mid appendIfNew、位置按设备 id 覆盖、回执用 Set，故同帧双至无害，无需额外去重层。
    private fun dispatchSealed(kind: Byte, sealed: ByteArray) {
        val ctx = appCtx ?: return
        val team = Identity.team(ctx)
        // 解密并验 MAC（G-CM-3）：错队伍码/被篡改/旧版明文一律丢弃（网络侧亦借此天然处理房间哈希碰撞）
        val body = MeshCrypto.decrypt(team, sealed) ?: return
        handlers[kind]?.invoke(body)
    }

    // MARK: - BleMesh.Listener（主线程）
    override fun onMeshMessage(payload: ByteArray) {
        if (payload.size < 2) return
        val kind = payload[0]
        val tlen = payload[1].toInt() and 0xFF
        if (payload.size < 2 + tlen) return
        val ctx = appCtx ?: return
        val team = String(payload, 2, tlen, Charsets.UTF_8)
        if (team != Identity.team(ctx)) return   // BLE 侧队伍过滤（明文 team）
        dispatchSealed(kind, payload.copyOfRange(2 + tlen, payload.size))
    }

    override fun onMeshPeers(count: Int) {
        peerCount = count
        peerHandlers.values.forEach { it(count) }
    }
}
