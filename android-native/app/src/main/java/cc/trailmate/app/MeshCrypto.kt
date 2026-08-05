package cc.trailmate.app

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 营地/位置消息端到端加密（G-CM-3）。与 iOS MeshCrypto.swift、夹具 meshcrypto.mjs 逐字节一致：
 *   密钥：PBKDF2-HMAC-SHA256(队伍码, "trailmate-mesh-v1", 10000 轮) → 64B = 32B AES 键 + 32B MAC 键
 *   格式：[ver=1][IV 16B][AES-256-CBC/PKCS7 密文][HMAC-SHA256(ver‖iv‖ct) 前 16B]
 * Encrypt-then-MAC；解密先验 MAC，不过即丢（错队伍码/被篡改/旧版明文都解不开）。
 * 跨平台校验向量（team=K7Q9ZP, iv=000102…0f, plain="hello camp"）：
 *   01000102030405060708090a0b0c0d0e0f93b370e0c48f2abe2f1bb1cdd2b5bf23592198c85af6ed3ae0adbe52a60157e6
 * 注意 minSdk 21 无 PBKDF2WithHmacSHA256 提供器，故 PBKDF2 手写（HmacSHA256 自 API 1 可用）。
 */
object MeshCrypto {
    const val VER: Byte = 1
    private val SALT = "trailmate-mesh-v1".toByteArray(Charsets.UTF_8)
    private const val ITER = 10000
    private const val MAC_LEN = 16

    private val rnd = SecureRandom()
    private val cache = HashMap<String, Pair<ByteArray, ByteArray>>()   // team -> (encKey, macKey)

    @Synchronized
    private fun keys(team: String): Pair<ByteArray, ByteArray> =
        cache.getOrPut(team) {
            val k = pbkdf2Sha256(team.toByteArray(Charsets.UTF_8), SALT, ITER, 64)
            Pair(k.copyOfRange(0, 32), k.copyOfRange(32, 64))
        }

    fun encrypt(team: String, plain: ByteArray): ByteArray {
        val (encKey, macKey) = keys(team)
        val iv = ByteArray(16).also { rnd.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(encKey, "AES"), IvParameterSpec(iv))
        val ct = cipher.doFinal(plain)
        val mac = hmacSha256(macKey, byteArrayOf(VER) + iv + ct).copyOfRange(0, MAC_LEN)
        return byteArrayOf(VER) + iv + ct + mac
    }

    fun decrypt(team: String, blob: ByteArray): ByteArray? {
        if (blob.size < 1 + 16 + 16 + MAC_LEN || blob[0] != VER) return null
        val (encKey, macKey) = keys(team)
        val iv = blob.copyOfRange(1, 17)
        val ct = blob.copyOfRange(17, blob.size - MAC_LEN)
        val mac = blob.copyOfRange(blob.size - MAC_LEN, blob.size)
        val expect = hmacSha256(macKey, byteArrayOf(VER) + iv + ct).copyOfRange(0, MAC_LEN)
        if (!constEq(mac, expect)) return null
        return try {
            val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(encKey, "AES"), IvParameterSpec(iv))
            cipher.doFinal(ct)
        } catch (_: Exception) { null }
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun constEq(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var r = 0
        for (i in a.indices) r = r or (a[i].toInt() xor b[i].toInt())
        return r == 0
    }

    // RFC 2898 PBKDF2-HMAC-SHA256（minSdk 21 无内建提供器，手写保证三端一致）
    private fun pbkdf2Sha256(pass: ByteArray, salt: ByteArray, iter: Int, keyLen: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(pass, "HmacSHA256"))
        val blocks = (keyLen + 31) / 32
        val out = ByteArray(blocks * 32)
        for (b in 1..blocks) {
            val idx = byteArrayOf((b shr 24).toByte(), (b shr 16).toByte(), (b shr 8).toByte(), b.toByte())
            var u = mac.doFinal(salt + idx)
            val t = u.copyOf()
            for (i in 2..iter) {
                u = mac.doFinal(u)
                for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
            System.arraycopy(t, 0, out, (b - 1) * 32, 32)
        }
        return out.copyOf(keyLen)
    }

    // 中继房间哈希（BR-1.2）：SHA256("trailmate-room-v1|" + 队伍码)。
    // 与加密派生盐 trailmate-mesh-v1 不同做域分离；上网的只有它，队伍码绝不上传。
    // 与 tests/mesh-fixture/meshcrypto.mjs 的 roomId 一致。
    fun roomId(team: String): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        val h = md.digest("trailmate-room-v1|$team".toByteArray(Charsets.UTF_8))
        return h.joinToString("") { "%02x".format(it) }
    }
}
