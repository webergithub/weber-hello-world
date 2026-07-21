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

    private var appCtx: Context? = null
    private var mesh: BleMesh? = null
    // 每类型单 handler：后注册者替换前者。Fragment 切 Tab 重建时新实例自动顶替旧实例，
    // 避免向单例累积 lambda 造成旧 Fragment 泄漏与消息重复处理。
    private val handlers = HashMap<Byte, (ByteArray) -> Unit>()
    private val peerHandlers = HashMap<String, (Int) -> Unit>()
    var peerCount = 0
        private set

    /** 幂等启动（需已授蓝牙权限）。返回是否成功开启。 */
    fun start(ctx: Context): Boolean {
        val app = ctx.applicationContext
        appCtx = app
        val m = mesh ?: BleMesh(app).also { it.listener = this; mesh = it }
        return m.start()
    }

    fun send(kind: Byte, payload: ByteArray) {
        val ctx = appCtx ?: return
        val teamStr = Identity.team(ctx)
        // 端到端加密（G-CM-3）：信封 team 明文分房，业务负载全密文
        val sealed = MeshCrypto.encrypt(teamStr, payload)
        val team = teamStr.toByteArray(Charsets.UTF_8).let {
            if (it.size > 32) it.copyOfRange(0, 32) else it
        }
        val frame = ByteArray(2 + team.size + sealed.size)
        frame[0] = kind
        frame[1] = team.size.toByte()
        System.arraycopy(team, 0, frame, 2, team.size)
        System.arraycopy(sealed, 0, frame, 2 + team.size, sealed.size)
        mesh?.send(frame)
    }

    fun subscribe(kind: Byte, handler: (ByteArray) -> Unit) {
        handlers[kind] = handler
    }

    fun onPeers(tag: String, handler: (Int) -> Unit) {
        peerHandlers[tag] = handler
        handler(peerCount)
    }

    // MARK: - BleMesh.Listener（主线程）
    override fun onMeshMessage(payload: ByteArray) {
        if (payload.size < 2) return
        val kind = payload[0]
        val tlen = payload[1].toInt() and 0xFF
        if (payload.size < 2 + tlen) return
        val ctx = appCtx ?: return
        val team = String(payload, 2, tlen, Charsets.UTF_8)
        if (team != Identity.team(ctx)) return   // 队伍过滤
        val sealed = payload.copyOfRange(2 + tlen, payload.size)
        // 解密并验 MAC（G-CM-3）：错队伍码/被篡改/旧版明文一律丢弃
        val body = MeshCrypto.decrypt(team, sealed) ?: return
        handlers[kind]?.invoke(body)
    }

    override fun onMeshPeers(count: Int) {
        peerCount = count
        peerHandlers.values.forEach { it(count) }
    }
}
