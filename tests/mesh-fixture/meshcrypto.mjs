// MeshCrypto 的 JS 参考实现（与 iOS MeshCrypto.swift / Android MeshCrypto.kt 逐字节一致）
//   密钥：PBKDF2-HMAC-SHA256(队伍码, "trailmate-mesh-v1", 10000) → 64B = 32B AES + 32B MAC
//   格式：[ver=1][IV 16B][AES-256-CBC/PKCS7 密文][HMAC-SHA256(ver‖iv‖ct) 前 16B]
import { pbkdf2Sync, createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const VER = 1
export const SALT = 'trailmate-mesh-v1'
export const ITER = 10000
export const MAC_LEN = 16

const cache = new Map()
function keys(team) {
  let k = cache.get(team)
  if (!k) {
    const d = pbkdf2Sync(Buffer.from(team, 'utf8'), Buffer.from(SALT, 'utf8'), ITER, 64, 'sha256')
    k = { enc: d.subarray(0, 32), mac: d.subarray(32, 64) }
    cache.set(team, k)
  }
  return k
}

export function encryptWithIv(team, plain, iv) {
  const k = keys(team)
  const c = createCipheriv('aes-256-cbc', k.enc, iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  const mac = createHmac('sha256', k.mac)
    .update(Buffer.concat([Buffer.from([VER]), iv, ct]))
    .digest()
    .subarray(0, MAC_LEN)
  return Buffer.concat([Buffer.from([VER]), iv, ct, mac])
}

export function encrypt(team, plain) {
  return encryptWithIv(team, plain, randomBytes(16))
}

export function decrypt(team, blob) {
  if (blob.length < 1 + 16 + 16 + MAC_LEN || blob[0] !== VER) return null
  const k = keys(team)
  const iv = blob.subarray(1, 17)
  const ct = blob.subarray(17, blob.length - MAC_LEN)
  const mac = blob.subarray(blob.length - MAC_LEN)
  const expect = createHmac('sha256', k.mac)
    .update(Buffer.concat([Buffer.from([VER]), iv, ct]))
    .digest()
    .subarray(0, MAC_LEN)
  if (!timingSafeEqual(mac, expect)) return null
  try {
    const d = createDecipheriv('aes-256-cbc', k.enc, iv)
    return Buffer.concat([d.update(ct), d.final()])
  } catch {
    return null
  }
}
