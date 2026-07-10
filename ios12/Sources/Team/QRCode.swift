import UIKit

// 二维码生成（CoreImage CIQRCodeGenerator，iOS 12 可用）。
enum QRCode {
    static let prefix = "TM:"   // 队伍二维码前缀，便于校验

    static func image(for text: String, size: CGFloat) -> UIImage? {
        guard let data = text.data(using: .utf8),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let ci = filter.outputImage else { return nil }
        let scale = size / ci.extent.width
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    // 从扫描文本解析队伍码：兼容 "TM:CODE" 与纯 6 位码
    static func parseTeam(_ scanned: String) -> String? {
        let s = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix(prefix) { return String(s.dropFirst(prefix.count)) }
        if s.range(of: "^[A-Z0-9]{4,12}$", options: .regularExpression) != nil { return s }
        return nil
    }
}
