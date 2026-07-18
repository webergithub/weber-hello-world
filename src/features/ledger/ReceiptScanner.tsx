import { useState } from 'react'
import { capturePhotoNative, isNativePlatform } from '../../lib/nativeCamera'

// 拍照/选图 -> OCR 识别小票 -> 猜测总金额与商户
export interface ReceiptResult {
  amount?: number // 元
  merchant?: string
  rawText: string
  image: string // dataURL
}

// 从 OCR 文本中提取最可能的总金额
export function guessAmount(text: string): number | undefined {
  const lines = text.split(/\r?\n/)
  const nums: { v: number; score: number }[] = []
  const keyword = /(合计|总计|应收|实收|金额|total|amount|应付|小计)/i
  for (const line of lines) {
    const matches = line.match(/\d+(?:[.,]\d{1,2})?/g)
    if (!matches) continue
    for (const m of matches) {
      const v = parseFloat(m.replace(',', '.'))
      if (!isFinite(v) || v <= 0 || v > 1_000_000) continue
      let score = 0
      if (keyword.test(line)) score += 100
      if (/[.,]\d{2}\b/.test(m)) score += 5 // 带两位小数更像金额
      score += Math.min(v, 9999) / 10000 // 略偏向较大值（总额）
      nums.push({ v, score })
    }
  }
  if (nums.length === 0) return undefined
  nums.sort((a, b) => b.score - a.score)
  return nums[0].v
}

export function guessMerchant(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 2 && l.length <= 20 && /[一-龥A-Za-z]/.test(l))
  return line || undefined
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

export function ReceiptScanner({
  onResult,
  onClose,
}: {
  onResult: (r: ReceiptResult) => void
  onClose: () => void
}) {
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)

  async function handleFile(file: File) {
    const image = await fileToDataUrl(file)
    await runOcr(image)
  }

  async function handleNativeCamera() {
    setBusy(true)
    setStatus('打开相机…')
    const image = await capturePhotoNative()
    if (!image) {
      setStatus('')
      setBusy(false)
      return
    }
    await runOcr(image)
  }

  async function runOcr(image: string) {
    setBusy(true)
    setPreview(image)
    try {
      setStatus('识别中（首次需下载中文语言包，请稍候）…')
      const Tesseract = (await import('tesseract.js')).default
      const { data } = await Tesseract.recognize(image, 'chi_sim+eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            setStatus(`识别中 ${Math.round((m.progress || 0) * 100)}%`)
          }
        },
      })
      const amount = guessAmount(data.text)
      const merchant = guessMerchant(data.text)
      setStatus('识别完成')
      onResult({ amount, merchant, rawText: data.text, image })
    } catch (e) {
      console.warn(e)
      setStatus('识别失败，可手动填写金额。图片已保存。')
      onResult({ rawText: '', image })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>拍照录入小票</h2>
        <p className="muted small">
          拍摄或选择小票照片，自动识别总金额并生成账单。识别在本机完成，图片不外传。
        </p>

        {isNativePlatform() ? (
          <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy} onClick={handleNativeCamera}>
            📷 拍照识别小票
          </button>
        ) : (
          <label className="btn primary block" style={{ marginTop: 12 }}>
            📷 拍照 / 选择小票
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
              }}
            />
          </label>
        )}

        {preview && <img className="receipt-preview" src={preview} alt="小票预览" />}
        {status && <div className="scan-status">{status}</div>}

        <button className="btn block" onClick={onClose} disabled={busy} style={{ marginTop: 14 }}>
          {busy ? '识别中…' : '取消'}
        </button>
      </div>
    </div>
  )
}
