import Foundation

// 共享蓝牙 Mesh 总线：全 App 只跑一套 BLE（一次广播+扫描），按「消息类型」路由。
// 营地聊天(kindChat) 与 跟车位置(kindLoc) 复用同一条链路。
// 帧结构：第 1 字节 = 类型码，其余 = 业务负载（BleMesh 负责分片/多跳/去重）。
final class MeshBus: BleMeshDelegate {
    static let shared = MeshBus()

    static let kindChat: UInt8 = 1
    static let kindLoc: UInt8 = 2

    private let mesh = BleMesh()
    private var started = false
    // 每类型单 handler：后注册者替换前者。VC 重建时新实例自动顶替旧实例，
    // 避免向单例累积闭包造成旧 VC 泄漏与消息重复处理（与 Android MeshBus.kt 行为一致）。
    private var handlers: [UInt8: (Data) -> Void] = [:]
    private var peerHandlers: [String: (Int) -> Void] = [:]
    private var stateHandlers: [String: (Bool) -> Void] = [:]
    private(set) var peerCount = 0
    private(set) var btAvailable = true

    private init() { mesh.delegate = self }

    func start() {
        if started { return }
        started = true
        mesh.start()
    }

    func send(_ kind: UInt8, _ payload: Data) {
        // 帧：[kind][teamLen][team...][payload...]，收端按 team 过滤实现"分队伍房间"
        let team = Array(Identity.team.utf8.prefix(32))
        var d = Data([kind, UInt8(team.count)])
        d.append(contentsOf: team)
        d.append(payload)
        mesh.send(d)
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

    // MARK: - BleMeshDelegate（主线程）
    func bleMesh(_ mesh: BleMesh, didReceive payload: Data) {
        // 解析 [kind][teamLen][team][body] 并按当前队伍码过滤
        guard payload.count >= 2 else { return }
        let bytes = [UInt8](payload)
        let kind = bytes[0]
        let tlen = Int(bytes[1])
        guard payload.count >= 2 + tlen else { return }
        let team = String(bytes: bytes[2..<(2 + tlen)], encoding: .utf8) ?? ""
        if team != Identity.team { return }
        let body = payload.subdata(in: (2 + tlen)..<payload.count)
        handlers[kind]?(body)
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
