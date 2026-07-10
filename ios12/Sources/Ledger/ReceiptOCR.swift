import UIKit
import Vision

// 小票识别：iOS 13+ 用 Vision 文字识别自动提取金额；iOS 12 无 Vision → 回退手动填写。
enum ReceiptOCR {

    // 识别图片文字（iOS 13+）。iOS 12 直接回调空串。
    static func recognizeText(_ image: UIImage, completion: @escaping (String) -> Void) {
        guard #available(iOS 13.0, *), let cg = image.cgImage else {
            completion("")
            return
        }
        let request = VNRecognizeTextRequest { req, _ in
            let text = (req.results as? [VNRecognizedTextObservation])?
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: "\n") ?? ""
            DispatchQueue.main.async { completion(text) }
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        if #available(iOS 14.0, *) { request.recognitionLanguages = ["zh-Hans", "en"] }
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        DispatchQueue.global(qos: .userInitiated).async {
            do { try handler.perform([request]) }
            catch { DispatchQueue.main.async { completion("") } }
        }
    }

    // 从 OCR 文本猜测总金额（分）。带"合计/总计/应付/total"等关键词的行加权，偏向两位小数与较大值。
    static func guessAmountCents(_ text: String) -> Int? {
        let keyword = try? NSRegularExpression(pattern: "合计|总计|应收|实收|应付|金额|小计|total|amount", options: [.caseInsensitive])
        let numRe = try? NSRegularExpression(pattern: "[0-9]+(?:[.,][0-9]{1,2})?", options: [])
        guard let numRe = numRe else { return nil }

        var best: (v: Double, score: Double)? = nil
        for line in text.split(separator: "\n").map(String.init) {
            let hasKeyword = keyword?.firstMatch(in: line, options: [], range: NSRange(line.startIndex..., in: line)) != nil
            let ns = line as NSString
            for m in numRe.matches(in: line, options: [], range: NSRange(location: 0, length: ns.length)) {
                let token = ns.substring(with: m.range).replacingOccurrences(of: ",", with: ".")
                guard let v = Double(token), v > 0, v < 1_000_000 else { continue }
                var score = 0.0
                if hasKeyword { score += 100 }
                if token.range(of: "\\.[0-9]{2}$", options: .regularExpression) != nil { score += 5 }
                score += min(v, 9999) / 10000
                if best == nil || score > best!.score { best = (v, score) }
            }
        }
        guard let b = best else { return nil }
        return Int((b.v * 100).rounded())
    }
}
