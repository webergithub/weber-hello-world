package cc.trailmate.app

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

// 变声：录音 → 变速重采样播放（卡通效果，零依赖）。升速=尖细(汤姆猫/花栗鼠)，降速=低沉(猪八戒/大魔王)。
// 说明：这是"变调+变速"的经典搞笑效果；iOS 版用 AVAudioUnitTimePitch 是保时长变调，二者听感不同但都很有趣。
class VoiceFragment : Fragment() {

    private data class Preset(val name: String, val factor: Double, val ringMod: Boolean = false)
    private val presets = listOf(
        Preset("🐱汤姆猫", 1.45),
        Preset("🐷小猪佩奇", 1.7),
        Preset("🐑喜羊羊", 1.6),
        Preset("🐵孙悟空", 1.25),
        Preset("🐗猪八戒", 0.72),
        Preset("🐿️花栗鼠", 1.9),
        Preset("🤖机器人", 1.0, ringMod = true),   // 40Hz 环形调制 → 金属机械音
        Preset("👹大魔王", 0.6),
        Preset("🎙️原声", 1.0),
    )
    private var factor = 1.45
    private var ringMod = false

    private val SR = 44100
    @Volatile private var recording = false
    private var recorded: ByteArray? = null
    private var track: AudioTrack? = null
    private lateinit var status: TextView
    private lateinit var recordBtn: Button
    private lateinit var playBtn: Button

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startRecording() else status.text = "需要麦克风权限"
        }

    override fun onCreateView(inflater: LayoutInflater, parent: ViewGroup?, s: Bundle?): View {
        val ctx = requireContext()
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(16))
        }
        root.addView(TextView(ctx).apply { text = "变声 · 录一段变个音"; textSize = 20f })
        root.addView(TextView(ctx).apply {
            text = "选角色 → 录音 → 播放。升调尖细 / 降调低沉。"
            textSize = 13f; setTextColor(0xFF888888.toInt()); setPadding(0, dp(6), 0, dp(10))
        })

        // 角色按钮（每行 3）
        var row: LinearLayout? = null
        presets.forEachIndexed { i, p ->
            if (i % 3 == 0) {
                row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                root.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })
            }
            row!!.addView(Button(ctx).apply {
                text = p.name
                setOnClickListener {
                    factor = p.factor
                    ringMod = p.ringMod
                    status.text = "已选：${p.name}"
                    recorded?.let { play() }   // 已录过则立即用新音色重放
                }
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(6) })
        }

        status = TextView(ctx).apply { textSize = 14f; setTextColor(0xFF0F766E.toInt()); setPadding(0, dp(14), 0, dp(10)) }
        root.addView(status)

        recordBtn = Button(ctx).apply { text = "⏺ 按住录音（松开播放）" }
        recordBtn.setOnTouchListener { _, e ->
            when (e.action) {
                android.view.MotionEvent.ACTION_DOWN -> { ensurePermThenRecord(); true }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { stopRecording(); true }
                else -> false
            }
        }
        root.addView(recordBtn, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })

        playBtn = Button(ctx).apply { text = "▶️ 重放刚才那段"; isEnabled = false; setOnClickListener { play() } }
        root.addView(playBtn, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) })

        return root
    }

    private fun ensurePermThenRecord() {
        val ctx = requireContext()
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startRecording()
        } else {
            permLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startRecording() {
        if (recording) return
        val min = AudioRecord.getMinBufferSize(SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            @Suppress("MissingPermission")
            AudioRecord(MediaRecorder.AudioSource.MIC, SR, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 4096))
        } catch (e: Exception) { status.text = "录音初始化失败"; return }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { status.text = "麦克风不可用"; rec.release(); return }
        recording = true
        status.text = "录音中…松开播放"
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        thread {
            try {
                @Suppress("MissingPermission")
                rec.startRecording()
                while (recording) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) out.write(buf, 0, n)
                }
                rec.stop()
            } catch (_: Exception) {} finally { rec.release() }
            recorded = out.toByteArray()
            activity?.runOnUiThread {
                playBtn.isEnabled = (recorded?.isNotEmpty() == true)
                if (recorded?.isNotEmpty() == true) play()
            }
        }
    }

    private fun stopRecording() {
        if (recording) { recording = false; status.text = "处理中…" }
    }

    // 保时长变调（G-VC-2）：线性重采样变调 + WSOLA 时间拉伸拉回原时长。
    // WSOLA 在每个合成帧的输入位置附近搜索"与前一帧自然延续相位最匹配"的偏移，
    // 避免纯 OLA 在音调信号上的帧间相位不连续（会造成八度错乱/颤动）。
    // 算法与 tests/mesh-fixture/pitchshift.mjs 一致，纯正弦已验证主频精确 ×f。
    private fun pitchPreserve(data: ByteArray, f: Double): ByteArray {
        if (f == 1.0) return data
        val src = ShortArray(data.size / 2) {
            (((data[it * 2 + 1].toInt()) shl 8) or (data[it * 2].toInt() and 0xFF)).toShort()
        }
        // 1) 重采样 ×f：音调 ×f，长度 ÷f
        val shifted = ShortArray((src.size / f).toInt()) { i ->
            val pos = i * f
            val i0 = pos.toInt().coerceAtMost(src.size - 1)
            val i1 = (i0 + 1).coerceAtMost(src.size - 1)
            val t = pos - i0
            ((src[i0] * (1 - t)) + (src[i1] * t)).toInt().toShort()
        }
        // 2) WSOLA 时间拉伸 ×f 拉回原时长：Hann 窗 50% 重叠 + 相位匹配搜索
        val frame = 1024
        val hs = frame / 2                    // 合成跳距
        val seek = 200                        // 相位匹配搜索半径
        val ha = (hs / f).coerceAtLeast(1.0)  // 分析跳距
        val outLen = src.size
        val acc = DoubleArray(outLen + frame)
        val norm = DoubleArray(outLen + frame)
        val win = DoubleArray(frame) { 0.5 - 0.5 * kotlin.math.cos(2.0 * Math.PI * it / (frame - 1)) }
        fun place(outPos: Int, inPos: Int) {
            for (j in 0 until frame) { acc[outPos + j] += shifted[inPos + j] * win[j]; norm[outPos + j] += win[j] }
        }
        place(0, 0)
        var prevInPos = 0; var outPos = hs; var k = 1
        while (outPos + frame < acc.size) {
            val nominal = (k * ha).toInt()
            val refStart = prevInPos + hs      // 前一帧自然延续处
            if (refStart + frame >= shifted.size) break
            var bestDelta = 0; var bestCorr = Double.NEGATIVE_INFINITY
            var delta = -seek
            while (delta <= seek) {
                val inPos = nominal + delta
                if (inPos >= 0 && inPos + frame < shifted.size) {
                    var corr = 0.0; var j = 0
                    while (j < frame) { corr += shifted[inPos + j].toDouble() * shifted[refStart + j]; j += 4 }
                    if (corr > bestCorr) { bestCorr = corr; bestDelta = delta }
                }
                delta++
            }
            val inPos = nominal + bestDelta
            if (inPos < 0 || inPos + frame >= shifted.size) break
            place(outPos, inPos)
            prevInPos = inPos; outPos += hs; k++
        }
        val out = ByteArray(outLen * 2)
        for (i in 0 until outLen) {
            val v = if (norm[i] > 1e-6) (acc[i] / norm[i]).toInt().coerceIn(-32768, 32767) else 0
            out[i * 2] = (v and 0xFF).toByte()
            out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
        }
        return out
    }

    // 机器人音色：16-bit PCM 环形调制（逐样本乘 40Hz 正弦），经典金属声
    private fun applyRingMod(src: ByteArray): ByteArray {
        val out = src.copyOf()
        val n = out.size / 2
        for (i in 0 until n) {
            val lo = out[i * 2].toInt() and 0xFF
            val hi = out[i * 2 + 1].toInt()
            val s = (hi shl 8) or lo
            val m = (s * kotlin.math.sin(2.0 * Math.PI * 40.0 * i / SR)).toInt().coerceIn(-32768, 32767)
            out[i * 2] = (m and 0xFF).toByte()
            out[i * 2 + 1] = ((m shr 8) and 0xFF).toByte()
        }
        return out
    }

    @Suppress("DEPRECATION")
    private fun play() {
        var data = recorded ?: return
        if (data.isEmpty()) return
        data = pitchPreserve(data, factor)   // 保时长变调（G-VC-2）
        if (ringMod) data = applyRingMod(data)
        runCatching { track?.stop(); track?.release() }
        val at = AudioTrack(
            AudioManager.STREAM_MUSIC, SR, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
            data.size, AudioTrack.MODE_STATIC
        )
        at.write(data, 0, data.size)
        at.play()
        track = at
        status.text = "播放中…"
    }

    override fun onPause() {
        super.onPause()
        recording = false
        runCatching { track?.stop(); track?.release() }
        track = null
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
