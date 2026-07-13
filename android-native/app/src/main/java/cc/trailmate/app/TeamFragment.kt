package cc.trailmate.app

import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

// 队伍：显示/新建队伍码 + 二维码（供他人扫码入队）+ 扫码入队。
// 与 iOS TeamViewController 同一 "TM:CODE" 约定，跨平台可互扫；入队后跟车位置/营地聊天仅本队互通。
class TeamFragment : Fragment() {
    private lateinit var codeLabel: TextView
    private lateinit var qr: ImageView
    private lateinit var hint: TextView

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val code = QrCode.parseTeam(result?.contents)
        if (code != null) { Identity.setTeam(requireContext(), code); refresh() }
    }

    override fun onCreateView(inflater: LayoutInflater, parent: ViewGroup?, s: Bundle?): View {
        val ctx = requireContext()
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(24), dp(24), dp(16))
        }
        root.addView(TextView(ctx).apply {
            text = "我的队伍码"; textSize = 15f; setTextColor(0xFF888888.toInt())
        })
        codeLabel = TextView(ctx).apply {
            textSize = 40f; setTextColor(0xFF0F766E.toInt()); setPadding(0, dp(6), 0, dp(6))
        }
        root.addView(codeLabel)

        qr = ImageView(ctx)
        root.addView(qr, LinearLayout.LayoutParams(dp(220), dp(220)))

        hint = TextView(ctx).apply {
            textSize = 13f; setTextColor(0xFF888888.toInt()); gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, dp(14))
        }
        root.addView(hint)

        val scan = Button(ctx).apply { text = "📷 扫码入队"; setOnClickListener { launchScan() } }
        root.addView(scan, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        val newBtn = Button(ctx).apply {
            text = "🔄 新建队伍"
            setOnClickListener { Identity.setTeam(requireContext(), Identity.newTeamCode()); refresh() }
        }
        root.addView(newBtn, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) })

        refresh()
        return root
    }

    private fun launchScan() {
        val opts = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("对准同伴的队伍二维码")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        scanLauncher.launch(opts)
    }

    private fun refresh() {
        val team = Identity.team(requireContext())
        if (team == "public") {
            codeLabel.text = "公共队"
            hint.text = "当前在「公共队」：附近所有人可互见。\n新建或扫码加入私有队伍后，仅与本队同伴互通位置与消息。"
        } else {
            codeLabel.text = team
            hint.text = "让同伴在本页「扫码入队」扫描上方二维码，\n即进入同一队伍（跟车位置 / 营地聊天仅本队互通，含 iOS 同伴）。"
        }
        qr.setImageBitmap(QrCode.bitmap(QrCode.PREFIX + team, dp(220)))
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
