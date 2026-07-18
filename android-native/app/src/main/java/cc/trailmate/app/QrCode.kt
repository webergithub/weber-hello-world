package cc.trailmate.app

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

// 队伍二维码：生成与解析。与 iOS QRCode.swift 同一 "TM:CODE" 约定，故安卓生成的码 iPhone 可扫、反之亦然。
object QrCode {
    const val PREFIX = "TM:"
    private val TEAM_RE = Regex("^[A-Z0-9]{4,12}$")

    fun bitmap(text: String, size: Int): Bitmap? = try {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 1
        )
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        for (x in 0 until size) for (y in 0 until size) {
            bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
        }
        bmp
    } catch (_: Exception) { null }

    // 兼容 "TM:CODE" 与纯 4~12 位大写字母数字
    fun parseTeam(scanned: String?): String? {
        val s = scanned?.trim() ?: return null
        if (s.startsWith(PREFIX)) return s.removePrefix(PREFIX)
        if (TEAM_RE.matches(s)) return s
        return null
    }
}
