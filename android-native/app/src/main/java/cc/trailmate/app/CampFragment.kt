package cc.trailmate.app

import android.Manifest
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import org.json.JSONObject
import java.util.UUID

// 营地：基于共享蓝牙 Mesh 的群聊。与 iOS 原生版同一协议：
// 文字 {mid,n,t,ts}（KIND_CHAT）；短语音 [u16 jsonLen][{mid,n,d,ts}][m4a]（KIND_VOICE，≤10s）。
class CampFragment : Fragment() {
    private lateinit var msgBox: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var status: TextView
    private lateinit var input: EditText

    private val seenMids = HashSet<String>()
    // (mid, 显示文本, 语音文件路径或 null)
    private val entries = ArrayList<Triple<String, String, String?>>()

    // 送达回执（G-CM-2）：自己发出的 mid → 已回执的设备 id 集合
    private val myMids = HashSet<String>()
    private val ackBy = HashMap<String, MutableSet<String>>()

    // 短语音（G-CM-1）
    private var recorder: android.media.MediaRecorder? = null
    private var recordFile: java.io.File? = null
    private var recordStart = 0L
    private var player: android.media.MediaPlayer? = null
    private val micLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) status.text = "需要麦克风权限才能发语音"
        }

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.all { it }) startMesh()
            else status.text = "需要蓝牙权限才能自组网（设置里授权后重进本页）"
        }

    // 链路健康自检（PR-P1-1）：蓝牙开关变化实时反映到界面，杜绝"蓝牙关了界面照常"的静默失效
    private val btStateReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context?, intent: android.content.Intent?) {
            when (intent?.getIntExtra(android.bluetooth.BluetoothAdapter.EXTRA_STATE, -1)) {
                android.bluetooth.BluetoothAdapter.STATE_OFF ->
                    status.text = "⚠️ 蓝牙已关闭，无法自组网（打开蓝牙后自动恢复）"
                android.bluetooth.BluetoothAdapter.STATE_ON -> {
                    startMesh(); renderStatus(MeshBus.peerCount)
                }
            }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, parent: ViewGroup?, s: Bundle?): View {
        val ctx = requireContext()
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(8))
        }

        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        head.addView(TextView(ctx).apply { text = "营地 · 蓝牙群聊"; textSize = 20f },
            LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        head.addView(Button(ctx).apply { text = "队伍"; setOnClickListener { promptTeam() } })
        head.addView(Button(ctx).apply { text = "昵称"; setOnClickListener { promptNick() } })
        root.addView(head)

        status = TextView(ctx).apply { textSize = 13f; setTextColor(0xFF3B7C74.toInt()) }
        root.addView(status)

        msgBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, dp(10))
        }
        scroll = ScrollView(ctx).apply { addView(msgBox) }
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        val bar = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        input = EditText(ctx).apply { hint = "说点什么…（蓝牙范围内互通）" }
        bar.addView(input, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        val mic = Button(ctx).apply { text = "🎤" }
        mic.setOnTouchListener { _, e ->
            when (e.action) {
                android.view.MotionEvent.ACTION_DOWN -> { startVoiceRecord(); true }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { stopVoiceAndSend(); true }
                else -> false
            }
        }
        bar.addView(mic)
        bar.addView(Button(ctx).apply { text = "发送"; setOnClickListener { sendChat() } })
        root.addView(bar)

        // 每次重建都注册：MeshBus 为"每类型单 handler"，新实例自动顶替旧实例
        MeshBus.subscribe(MeshBus.KIND_CHAT) { body -> onChat(body) }
        MeshBus.subscribe(MeshBus.KIND_VOICE) { body -> onVoice(body) }
        MeshBus.subscribe(MeshBus.KIND_ACK) { body -> onAck(body) }
        MeshBus.onPeers("camp") { n -> renderStatus(n) }
        ctx.registerReceiver(btStateReceiver,
            android.content.IntentFilter(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED))
        ensurePermissionsThenStart()
        renderStatus(MeshBus.peerCount)
        renderLog()
        return root
    }

    override fun onDestroyView() {
        super.onDestroyView()
        runCatching { requireContext().unregisterReceiver(btStateReceiver) }
        runCatching { recorder?.release() }; recorder = null
        runCatching { player?.release() }; player = null
    }

    // MARK: - 权限与启动
    private fun ensurePermissionsThenStart() {
        val ctx = requireContext()
        val need = if (Build.VERSION.SDK_INT >= 31) arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT
        ) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        val missing = need.filter {
            ContextCompat.checkSelfPermission(ctx, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) startMesh() else permLauncher.launch(missing.toTypedArray())
    }

    private fun startMesh() {
        val ok = MeshBus.start(requireContext())
        if (!ok) status.text = "蓝牙未开启或不可用，请打开蓝牙后重进本页"
    }

    // MARK: - 收发
    private fun sendChat() {
        val ctx = requireContext()
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        val mid = UUID.randomUUID().toString()
        myMids.add(mid)   // 送达回执按此聚合（G-CM-2）
        val json = JSONObject()
            .put("mid", mid).put("n", Identity.nick(ctx)).put("t", text)
            .put("ts", System.currentTimeMillis() / 1000.0)
        appendIfNew(mid, "我：$text")
        MeshBus.send(MeshBus.KIND_CHAT, json.toString().toByteArray(Charsets.UTF_8))
        input.setText("")
        // 送达可见性（PR-P1-2 部分）：无邻居时如实告知，不让用户以为"发出去了"
        if (MeshBus.peerCount == 0) {
            status.text = "⚠️ 附近无蓝牙邻居，这条消息此刻无人能收到"
        }
    }

    private fun onChat(body: ByteArray) {
        try {
            val o = JSONObject(String(body, Charsets.UTF_8))
            if (appendIfNew(o.getString("mid"), "${o.getString("n")}：${o.getString("t")}")) {
                sendAck(o.getString("mid"))
            }
        } catch (_: Exception) {}
    }

    // MARK: - 送达回执（G-CM-2）
    private fun sendAck(mid: String) {
        val ctx = context ?: return
        val json = JSONObject().put("mid", mid).put("by", Identity.deviceId(ctx))
        MeshBus.send(MeshBus.KIND_ACK, json.toString().toByteArray(Charsets.UTF_8))
    }

    private fun onAck(body: ByteArray) {
        try {
            val o = JSONObject(String(body, Charsets.UTF_8))
            val mid = o.getString("mid")
            if (mid !in myMids) return   // 只关心自己发的消息
            val added = ackBy.getOrPut(mid) { HashSet() }.add(o.getString("by"))
            if (added) renderLog()       // "✓已送达 N" 随回执刷新
        } catch (_: Exception) {}
    }

    // MARK: - 短语音（G-CM-1）
    private fun startVoiceRecord() {
        val ctx = requireContext()
        if (androidx.core.content.ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            micLauncher.launch(Manifest.permission.RECORD_AUDIO); return
        }
        val f = java.io.File(ctx.cacheDir, "voice_out.m4a")
        val r = android.media.MediaRecorder()
        try {
            r.setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(16000)
            r.setAudioEncodingBitRate(24000)
            r.setAudioChannels(1)
            r.setMaxDuration(10_000)   // ≤10s：约 30KB，BLE 泛洪 2~3 秒可达
            r.setOutputFile(f.absolutePath)
            r.prepare(); r.start()
            recorder = r; recordFile = f; recordStart = System.currentTimeMillis()
            status.text = "🎤 录音中…松开发送（最长 10 秒）"
        } catch (_: Exception) { r.release(); status.text = "录音启动失败" }
    }

    private fun stopVoiceAndSend() {
        val r = recorder ?: return
        recorder = null
        val durMs = System.currentTimeMillis() - recordStart
        runCatching { r.stop() }; r.release()
        val f = recordFile ?: return
        if (durMs < 400 || !f.exists()) { status.text = "太短，未发送"; return }
        val m4a = f.readBytes()
        if (m4a.size > 40_000) { status.text = "语音过长（>${m4a.size / 1000}KB），未发送"; return }
        val ctx = requireContext()
        val mid = UUID.randomUUID().toString()
        val d = (durMs / 1000.0 * 10).toInt() / 10.0
        val json = JSONObject().put("mid", mid).put("n", Identity.nick(ctx))
            .put("d", d).put("ts", System.currentTimeMillis() / 1000.0)
            .toString().toByteArray(Charsets.UTF_8)
        val payload = ByteArray(2 + json.size + m4a.size)
        payload[0] = (json.size shr 8).toByte(); payload[1] = json.size.toByte()
        System.arraycopy(json, 0, payload, 2, json.size)
        System.arraycopy(m4a, 0, payload, 2 + json.size, m4a.size)
        myMids.add(mid)   // 送达回执按此聚合（G-CM-2）
        val mine = java.io.File(ctx.cacheDir, "voice_$mid.m4a").also { f.copyTo(it, overwrite = true) }
        appendIfNew(mid, "我：🎤 语音 ${d}s（点按播放）", mine.absolutePath)
        MeshBus.send(MeshBus.KIND_VOICE, payload)
        status.text = if (MeshBus.peerCount == 0) "⚠️ 附近无蓝牙邻居，这条语音此刻无人能收到" else "语音已发出（${m4a.size / 1000}KB）"
    }

    private fun onVoice(body: ByteArray) {
        try {
            if (body.size < 3) return
            val jlen = ((body[0].toInt() and 0xFF) shl 8) or (body[1].toInt() and 0xFF)
            if (body.size < 2 + jlen + 1) return
            val o = JSONObject(String(body, 2, jlen, Charsets.UTF_8))
            val mid = o.getString("mid")
            val ctx = context ?: return
            val f = java.io.File(ctx.cacheDir, "voice_$mid.m4a")
            f.writeBytes(body.copyOfRange(2 + jlen, body.size))
            if (appendIfNew(mid, "${o.getString("n")}：🎤 语音 ${o.optDouble("d", 0.0)}s（点按播放）", f.absolutePath)) {
                sendAck(mid)
            }
        } catch (_: Exception) {}
    }

    private fun play(path: String) {
        runCatching { player?.release() }
        player = android.media.MediaPlayer().apply {
            setDataSource(path); prepare(); start()
        }
    }

    private fun appendIfNew(mid: String, line: String, voicePath: String? = null): Boolean {
        if (!seenMids.add(mid)) return false
        entries.add(Triple(mid, line, voicePath))
        renderLog()
        return true
    }

    private fun renderLog() {
        val ctx = context ?: return
        msgBox.removeAllViews()
        if (entries.isEmpty()) {
            msgBox.addView(TextView(ctx).apply {
                textSize = 15f
                text = "还没有消息。开启蓝牙、与附近同伴（iOS/安卓均可）进入本页即可互聊互发语音，无需网络。"
            })
        } else {
            entries.forEach { (mid, line, voicePath) ->
                val acks = ackBy[mid]?.size ?: 0
                msgBox.addView(TextView(ctx).apply {
                    textSize = 15f
                    setPadding(0, dp(3), 0, dp(3))
                    text = if (acks > 0) "$line  ✓已送达 $acks" else line
                    if (voicePath != null) {
                        setTextColor(0xFF0F766E.toInt())
                        setOnClickListener { play(voicePath) }
                    }
                })
            }
        }
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun renderStatus(peers: Int) {
        val ctx = context ?: return
        status.text = "队伍 ${Identity.team(ctx)} · 蓝牙邻居 $peers"
    }

    // MARK: - 设置
    private fun promptNick() {
        val ctx = requireContext()
        val e = EditText(ctx).apply { setText(Identity.nick(ctx)) }
        AlertDialog.Builder(ctx).setTitle("改昵称").setView(e)
            .setNegativeButton("取消", null)
            .setPositiveButton("保存") { _, _ ->
                val n = e.text.toString().trim()
                if (n.isNotEmpty()) Identity.setNick(ctx, n)
            }.show()
    }

    private fun promptTeam() {
        val ctx = requireContext()
        val e = EditText(ctx).apply {
            setText(Identity.team(ctx))
            hint = "输入同伴的队伍码；留空回公共队"
        }
        AlertDialog.Builder(ctx).setTitle("队伍码（同码才互通，含 iOS 同伴）").setView(e)
            .setNegativeButton("取消", null)
            .setPositiveButton("保存") { _, _ ->
                Identity.setTeam(ctx, e.text.toString().uppercase().trim())
                renderStatus(MeshBus.peerCount)
            }.show()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
