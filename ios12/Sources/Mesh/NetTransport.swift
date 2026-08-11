import Foundation

// 网络中继通道（BR-1.1，iOS 12 侧）：与 BLE 并行的第二条传输路，补上"超 BLE 距离即失效"（G-NET-1）。
//
// 为什么是长轮询而不是 WebSocket（决策 D-2）：iOS 12 没有 URLSessionWebSocketTask（iOS 13+ 才有），
// 手写 RFC 6455 约 300 行、或引入 Starscream 破坏"零第三方依赖"约束。而位置本就 3 秒一报，
// 长轮询用 URLSession 即可，iOS 12 原生可用、实现量减半。服务端与 WebSocket 成员同房互通，
// 因此 iOS(长轮询) ↔ Android(WebSocket) 可跨传输互见。
//
// 只发密文：上行 roomId(队伍码) + kind + base64(端到端密文)，**队伍码绝不上传**（见 ④§3.3）。
// 鲁棒性（BR-1.4）：任何失败都只做退避重试，绝不抛错、绝不弹窗；baseUrl 为空即完全不启用。
final class NetTransport {
    private let baseUrl: String
    private let room: String
    private let token: String
    private let onFrame: (UInt8, Data) -> Void   // 收到中继帧：kind + 密文
    private let onCloud: (Int) -> Void           // 云端在线数（BR-1.5）

    private let session: URLSession
    private var sid: String?
    private var stopped = true
    private var backoff: TimeInterval = 1
    private(set) var cloudCount = 0

    init(baseUrl: String, room: String, token: String,
         onFrame: @escaping (UInt8, Data) -> Void, onCloud: @escaping (Int) -> Void) {
        self.baseUrl = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        self.room = room
        self.token = token
        self.onFrame = onFrame
        self.onCloud = onCloud
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 35        // 略大于服务端 25s 挂起
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    func start() {
        guard !baseUrl.isEmpty else { return }
        stopped = false
        join()
    }

    func stop() {
        stopped = true
        if let s = sid { post("/relay/leave", ["sid": s]) { _ in } }
        sid = nil
        setCloud(0)
    }

    func relay(_ kind: UInt8, _ sealed: Data) {
        guard let s = sid else { return }
        post("/relay/send", ["sid": s, "kind": Int(kind), "body": sealed.base64EncodedString()]) { _ in }
    }

    // MARK: - 内部
    private func setCloud(_ n: Int) {
        cloudCount = n
        DispatchQueue.main.async { [weak self] in self?.onCloud(n) }
    }

    private func join() {
        guard !stopped else { return }
        var body: [String: Any] = ["room": room]
        if !token.isEmpty { body["token"] = token }
        post("/relay/join", body) { [weak self] json in
            guard let self = self, !self.stopped else { return }
            if let j = json, let sid = j["sid"] as? String {
                self.sid = sid
                self.backoff = 1
                self.setCloud(j["peers"] as? Int ?? 0)
                self.poll()
            } else {
                self.retry { self.join() }   // 服务端不可达/鉴权失败：静默退避重试
            }
        }
    }

    private func poll() {
        guard !stopped, let s = sid,
              let url = URL(string: "\(baseUrl)/relay/poll?sid=\(s)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        session.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self = self, !self.stopped else { return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 403 {                       // 会话已被回收 → 重新入房
                self.sid = nil
                self.retry { self.join() }
                return
            }
            if code == 200, let d = data,
               let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let frames = j["frames"] as? [[String: Any]] {
                for f in frames {
                    guard let k = f["kind"] as? Int, let b = f["body"] as? String,
                          let sealed = Data(base64Encoded: b) else { continue }
                    DispatchQueue.main.async { [weak self] in self?.onFrame(UInt8(k & 0xFF), sealed) }
                }
                self.backoff = 1
                self.poll()                        // 立即续挂下一轮
            } else {
                self.retry { self.poll() }         // 超时/网络抖动：退避后再挂
            }
        }.resume()
    }

    private func retry(_ work: @escaping () -> Void) {
        let d = backoff
        backoff = min(backoff * 2, 16)
        DispatchQueue.global().asyncAfter(deadline: .now() + d) { [weak self] in
            guard let self = self, !self.stopped else { return }
            work()
        }
    }

    private func post(_ path: String, _ body: [String: Any], _ done: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: baseUrl + path),
              let data = try? JSONSerialization.data(withJSONObject: body) else { done(nil); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = data
        session.dataTask(with: req) { d, _, _ in
            guard let d = d, !d.isEmpty,
                  let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { done(nil); return }
            done(j)
        }.resume()
    }
}
