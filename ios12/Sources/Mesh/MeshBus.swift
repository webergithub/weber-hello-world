import Foundation

// 共享蓝牙 Mesh 总线：全 App 只跑一套 BLE（一次广播+扫描），按「消息类型」路由。
// 营地聊天(kindChat) 与 跟车位置(kindLoc) 复用同一条链路。
// 帧结构：第 1 字节 = 类型码，其余 = 业务负载（BleMesh 负责分片/多跳/去重）。
final class MeshBus: BleMeshDelegate {
    static let shared = MeshBus()

    static let kindChat: UInt8 = 1
    static let kindLoc: UInt8 = 2
    static let kindVoice: UInt8 = 3   // 短语音（G-CM-1）：[u16 jsonLen][json{mid,n,d,ts}][m4a 字节]
    static let kindAck: UInt8 = 4     // 送达回执（G-CM-2）：json{mid,by}，收到聊天/语音后回发

    private let mesh = BleMesh()
    private var net: NetTransport?
    private var started = false
    // 每类型单 handler：后注册者替换前者。VC 重建时新实例自动顶替旧实例，
    // 避免向单例累积闭包造成旧 VC 泄漏与消息重复处理（与 Android MeshBus.kt 行为一致）。
    private var handlers: [UInt8: (Data) -> Void] = [:]
    private var peerHandlers: [String: (Int) -> Void] = [:]
    private var stateHandlers: [String: (Bool) -> Void] = [:]
    private var cloudHandlers: [String: (Int) -> Void] = [:]
    private(set) var peerCount = 0
    private(set) var btAvailable = true
    private(set) var cloudCount = 0   // 云端在线数（BR-1.5：与蓝牙邻居分开，不混淆）

    private init() { mesh.delegate = self }

    func start() {
        if started { return }
        started = true
        mesh.start()
        startNet()   // 网络中继与 BLE 并行（BR-1.1）；relayUrl 为空则空转
    }

    // 启动/重启网络通道。队伍码变化或首次配置 URL 时调用。
    func startNet() {
        net?.stop()
        net = nil
        cloudCount = 0
        let url = Identity.relayUrl
        if url.isEmpty { cloudHandlers.values.forEach { $0(0) }; return }
        let t = NetTransport(
            baseUrl: url,
            room: MeshCrypto.roomId(Identity.team),
            token: Identity.relayToken,
            onFrame: { [weak self] kind, sealed in self?.dispatchSealed(kind, sealed) },
            onCloud: { [weak self] n in
                guard let self = self else { return }
                self.cloudCount = n
                self.cloudHandlers.values.forEach { $0(n) }
            })
        net = t
        t.start()
    }

    func send(_ kind: UInt8, _ payload: Data) {
        // 帧：[kind][teamLen][team...][密文...]，收端按 team 过滤实现"分队伍房间"
        // 端到端加密（G-CM-3）：信封 team 明文分房，业务负载全密文
        let sealed = MeshCrypto.encrypt(team: Identity.team, payload)
        let team = Array(Identity.team.utf8.prefix(32))
        var d = Data([kind, UInt8(team.count)])
        d.append(contentsOf: team)
        d.append(sealed)
        mesh.send(d)
        // 网络通道：只发 roomId + kind + 密文，**队伍码不上网**（BR-1.2）
        net?.relay(kind, sealed)
    }

    // 订阅某类型消息（负载已去掉类型字节）。同类型重复订阅时新 handler 顶替旧的。
    func subscribe(_ kind: UInt8, _ handler: @escaping (Data) -> Void) {
        handlers[kind] = handler
    }

    // 邻居数变化观察（立即回调一次当前值）；同 tag 重复注册时顶替
    func onPeers(_ tag: String = "default", _ handler: @escaping (Int) -> Void) {
        peerHandlers[tag] = handler
        handler(peerCount)
    }

    // 蓝牙可用性观察（PR-P1-1，立即回调一次当前值）；同 tag 顶替
    func onState(_ tag: String = "default", _ handler: @escaping (Bool) -> Void) {
        stateHandlers[tag] = handler
        handler(btAvailable)
    }

    // 云端在线数观察（BR-1.5，立即回调一次当前值）；同 tag 顶替
    func onCloud(_ tag: String = "default", _ handler: @escaping (Int) -> Void) {
        cloudHandlers[tag] = handler
        handler(cloudCount)
    }

    // 解密并分发（两条通道共用）。BR-1.3 双通道去重：业务层已幂等——
    // 聊天/语音按 mid appendIfNew、位置按设备 id 覆盖、回执用 Set，故同帧双至无害，无需额外去重层。
    private func dispatchSealed(_ kind: UInt8, _ sealed: Data) {
        // 解密并验 MAC（G-CM-3）：错队伍码/被篡改/旧版明文一律丢弃（网络侧亦借此天然处理房间哈希碰撞）
        guard let body = MeshCrypto.decrypt(team: Identity.team, sealed) else { return }
        handlers[kind]?(body)
    }

    // MARK: - BleMeshDelegate（主线程）
    func bleMesh(_ mesh: BleMesh, didReceive payload: Data) {
        // 解析 [kind][teamLen][team][body] 并按当前队伍码过滤
        guard payload.count >= 2 else { return }
        let bytes = [UInt8](payload)
        let kind = bytes[0]
        let tlen = Int(bytes[1])
        guard payload.count >= 2 + tlen else { return }
        let team = String(bytes: bytes[2..<(2 + tlen)], encoding: .utf8) ?? ""
        if team != Identity.team { return }   // BLE 侧队伍过滤（明文 team）
        dispatchSealed(kind, payload.subdata(in: (2 + tlen)..<payload.count))
    }

    func bleMeshDidUpdatePeers(_ count: Int) {
        peerCount = count
        peerHandlers.values.forEach { $0(count) }
    }

    func bleMeshDidUpdateState(_ available: Bool) {
        btAvailable = available
        stateHandlers.values.forEach { $0(available) }
    }
}
