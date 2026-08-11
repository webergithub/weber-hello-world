import Foundation
import CommonCrypto

// 营地/位置消息端到端加密（G-CM-3）。与 Android MeshCrypto.kt、夹具 meshcrypto.mjs 逐字节一致：
//   密钥：PBKDF2-HMAC-SHA256(队伍码, "trailmate-mesh-v1", 10000 轮) → 64B = 32B AES 键 + 32B MAC 键
//   格式：[ver=1][IV 16B][AES-256-CBC/PKCS7 密文][HMAC-SHA256(ver‖iv‖ct) 前 16B]
// Encrypt-then-MAC；解密先验 MAC，不过即丢。全部走 CommonCrypto，iOS 12 可用。
// 跨平台校验向量（team=K7Q9ZP, iv=000102…0f, plain="hello camp"）：
//   01000102030405060708090a0b0c0d0e0f93b370e0c48f2abe2f1bb1cdd2b5bf23592198c85af6ed3ae0adbe52a60157e6
enum MeshCrypto {
    static let VER: UInt8 = 1
    private static let SALT = Array("trailmate-mesh-v1".utf8)
    private static let ITER: UInt32 = 10000
    private static let MAC_LEN = 16

    private static var cache: [String: (enc: [UInt8], mac: [UInt8])] = [:]

    private static func keys(for team: String) -> (enc: [UInt8], mac: [UInt8]) {
        if let k = cache[team] { return k }
        var out = [UInt8](repeating: 0, count: 64)
        let pass = Array(team.utf8)
        pass.withUnsafeBufferPointer { pp in
            SALT.withUnsafeBufferPointer { sp in
                _ = CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    UnsafeRawPointer(pp.baseAddress!).assumingMemoryBound(to: Int8.self), pass.count,
                    sp.baseAddress!, SALT.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), ITER,
                    &out, out.count)
            }
        }
        let k = (enc: Array(out[0..<32]), mac: Array(out[32..<64]))
        cache[team] = k
        return k
    }

    static func encrypt(team: String, _ plain: Data) -> Data {
        let k = keys(for: team)
        var iv = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, iv.count, &iv)
        let ct = aes(k.enc, iv: iv, input: [UInt8](plain), encrypt: true) ?? []
        let mac = Array(hmacSha256(k.mac, [VER] + iv + ct)[0..<MAC_LEN])
        return Data([VER] + iv + ct + mac)
    }

    static func decrypt(team: String, _ blob: Data) -> Data? {
        let bytes = [UInt8](blob)
        guard bytes.count >= 1 + 16 + 16 + MAC_LEN, bytes[0] == VER else { return nil }
        let k = keys(for: team)
        let iv = Array(bytes[1..<17])
        let ct = Array(bytes[17..<(bytes.count - MAC_LEN)])
        let mac = Array(bytes[(bytes.count - MAC_LEN)...])
        let expect = Array(hmacSha256(k.mac, [VER] + iv + ct)[0..<MAC_LEN])
        guard constEq(mac, expect) else { return nil }
        guard let plain = aes(k.enc, iv: iv, input: ct, encrypt: false) else { return nil }
        return Data(plain)
    }

    private static func aes(_ key: [UInt8], iv: [UInt8], input: [UInt8], encrypt: Bool) -> [UInt8]? {
        var out = [UInt8](repeating: 0, count: input.count + kCCBlockSizeAES128)
        var moved = 0
        let st = CCCrypt(
            CCOperation(encrypt ? kCCEncrypt : kCCDecrypt),
            CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
            key, key.count, iv,
            input, input.count,
            &out, out.count, &moved)
        guard st == kCCSuccess else { return nil }
        return Array(out[0..<moved])
    }

    private static func hmacSha256(_ key: [UInt8], _ data: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), key, key.count, data, data.count, &out)
        return out
    }

    // 中继房间哈希（BR-1.2）：SHA256("trailmate-room-v1|" + 队伍码)。
    // 与加密派生盐 trailmate-mesh-v1 不同做域分离；上网的只有它，队伍码绝不上传。
    // 与 Android MeshCrypto.roomId / 夹具 meshcrypto.mjs 一致。
    static func roomId(_ team: String) -> String {
        let input = Array("trailmate-room-v1|\(team)".utf8)
        var out = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256(input, CC_LONG(input.count), &out)
        return out.map { String(format: "%02x", $0) }.joined()
    }

    private static func constEq(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var r: UInt8 = 0
        for i in a.indices { r |= a[i] ^ b[i] }
        return r == 0
    }
}
