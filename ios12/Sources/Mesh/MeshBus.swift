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
    private var handlers: [UInt8: [(Data) -> Void]] = [:]
    private var peerHandlers: [(Int) -> Void] = []
    private(set) var peerCount = 0

    private init() { mesh.delegate = self }

    func start() {
        if started { return }
        started = true
        mesh.start()
    }

    func send(_ kind: UInt8, _ payload: Data) {
        var d = Data([kind])
        d.append(payload)
        mesh.send(d)
    }

    // 订阅某类型消息（负载已去掉类型字节）。VC 只在创建时订阅一次。
    func subscribe(_ kind: UInt8, _ handler: @escaping (Data) -> Void) {
        handlers[kind, default: []].append(handler)
    }

    // 邻居数变化观察（立即回调一次当前值）
    func onPeers(_ handler: @escaping (Int) -> Void) {
        peerHandlers.append(handler)
        handler(peerCount)
    }

    // MARK: - BleMeshDelegate（主线程）
    func bleMesh(_ mesh: BleMesh, didReceive payload: Data) {
        guard let kind = payload.first, payload.count >= 1 else { return }
        let body = payload.count > 1 ? payload.subdata(in: 1..<payload.count) : Data()
        handlers[kind]?.forEach { $0(body) }
    }

    func bleMeshDidUpdatePeers(_ count: Int) {
        peerCount = count
        peerHandlers.forEach { $0(count) }
    }
}
