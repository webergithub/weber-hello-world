import { useEffect, useRef } from 'react'
import { Html5Qrcode } from 'html5-qrcode'

// 扫描二维码组件。成功后回调解析出的文本。
export function QrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void
  onClose: () => void
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  useEffect(() => {
    let cancelled = false
    const regionId = 'qr-region'
    if (elRef.current) elRef.current.id = regionId
    const scanner = new Html5Qrcode(regionId)
    scannerRef.current = scanner

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          if (cancelled) return
          cancelled = true
          onResult(decoded)
        },
        () => {},
      )
      .catch((err) => {
        console.warn('无法启动摄像头：', err)
      })

    return () => {
      cancelled = true
      scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => {})
    }
  }, [onResult])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>扫描二维码加入</h2>
        <div ref={elRef} style={{ width: '100%', borderRadius: 12, overflow: 'hidden' }} />
        <p className="muted small" style={{ marginTop: 10 }}>
          将朋友展示的加入二维码对准取景框。需要授权摄像头权限。
        </p>
        <button className="btn block" onClick={onClose} style={{ marginTop: 12 }}>
          取消
        </button>
      </div>
    </div>
  )
}
