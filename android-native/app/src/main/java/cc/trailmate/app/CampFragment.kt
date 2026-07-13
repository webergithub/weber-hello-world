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

// 营地：基于共享蓝牙 Mesh 的群聊。与 iOS 原生版同一 JSON 协议（{mid,n,t,ts}），同队伍码跨平台互通。
class CampFragment : Fragment() {
    private lateinit var log: TextView
    private lateinit var scroll: ScrollView
    private lateinit var status: TextView
    private lateinit var input: EditText

    private val seenMids = HashSet<String>()
    private val lines = ArrayList<String>()

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.all { it }) startMesh()
            else status.text = "需要蓝牙权限才能自组网（设置里授权后重进本页）"
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

        log = TextView(ctx).apply { textSize = 15f; setPadding(0, dp(10), 0, dp(10)); setLineSpacing(dp(4).toFloat(), 1f) }
        scroll = ScrollView(ctx).apply { addView(log) }
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        val bar = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        input = EditText(ctx).apply { hint = "说点什么…（蓝牙范围内互通）" }
        bar.addView(input, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        bar.addView(Button(ctx).apply { text = "发送"; setOnClickListener { sendChat() } })
        root.addView(bar)

        // 每次重建都注册：MeshBus 为"每类型单 handler"，新实例自动顶替旧实例
        MeshBus.subscribe(MeshBus.KIND_CHAT) { body -> onChat(body) }
        MeshBus.onPeers("camp") { n -> renderStatus(n) }
        ensurePermissionsThenStart()
        renderStatus(MeshBus.peerCount)
        renderLog()
        return root
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
        val json = JSONObject()
            .put("mid", mid).put("n", Identity.nick(ctx)).put("t", text)
            .put("ts", System.currentTimeMillis() / 1000.0)
        appendIfNew(mid, "我：$text")
        MeshBus.send(MeshBus.KIND_CHAT, json.toString().toByteArray(Charsets.UTF_8))
        input.setText("")
    }

    private fun onChat(body: ByteArray) {
        try {
            val o = JSONObject(String(body, Charsets.UTF_8))
            appendIfNew(o.getString("mid"), "${o.getString("n")}：${o.getString("t")}")
        } catch (_: Exception) {}
    }

    private fun appendIfNew(mid: String, line: String) {
        if (!seenMids.add(mid)) return
        lines.add(line)
        renderLog()
    }

    private fun renderLog() {
        log.text = if (lines.isEmpty())
            "还没有消息。开启蓝牙、与附近同伴（iOS/安卓均可）进入本页即可互聊，无需网络。"
        else lines.joinToString("\n")
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
