import Foundation
import CoreBluetooth

// 原生蓝牙自组网（BLE Mesh）—— iOS 12+ CoreBluetooth。
// 每台设备同时作 外围(CBPeripheralManager 广播+GATT服务) 与 中心(CBCentralManager 扫描+连接)，
// 蓝牙范围内任意两机即可直连互发；多跳 TTL 泛洪把消息中继给"朋友的朋友"，msgId 去重防风暴。
// 承载的是不透明 Data 帧，上层（营地聊天）自行编码/解码内容。

protocol BleMeshDelegate: AnyObject {
    func bleMesh(_ mesh: BleMesh, didReceive payload: Data)
    func bleMeshDidUpdatePeers(_ count: Int)
    // 链路健康（PR-P1-1）：蓝牙可用性变化（关闭/未授权 → false）
    func bleMeshDidUpdateState(_ available: Bool)
}

final class BleMesh: NSObject {
    weak var delegate: BleMeshDelegate?

    private let serviceUUID = CBUUID(string: "7B2F9A10-4C3D-4B8E-9F21-0A1B2C3D4E5F")
    private let charUUID = CBUUID(string: "7B2F9A11-4C3D-4B8E-9F21-0A1B2C3D4E5F")

    private let HEADER = 13          // 8 msgId + 1 ttl + 2 seq + 2 total
    private let PAYLOAD = 180
    private let REASM_TTL: TimeInterval = 10
    private let SEEN_TTL: TimeInterval = 30
    private let MAX_TTL = 4

    private var central: CBCentralManager?
    private var peripheralMgr: CBPeripheralManager?
    private var mutableChar: CBMutableCharacteristic?

    private var discovered: [UUID: CBPeripheral] = [:]
    private var clientChars: [UUID: CBCharacteristic] = [:]
    private var subscribers: [CBCentral] = []

    private final class Reasm {
        var chunks: [Data?]; var received = 0; var ts = Date(); var ttl = 0; var msgId = Data()
        init(total: Int) { chunks = Array(repeating: nil, count: total) }
    }
    private var reasm: [String: Reasm] = [:]
    private var seen: [String: Date] = [:]

    private var running = false
    private let queue = DispatchQueue(label: "trailmate.ble.mesh")

    // MARK: - 生命周期
    func start() {
        running = true
        if central == nil { central = CBCentralManager(delegate: self, queue: queue) }
        if peripheralMgr == nil { peripheralMgr = CBPeripheralManager(delegate: self, queue: queue) }
        startPeripheralIfReady()
        startCentralIfReady()
    }

    func stop() {
        running = false
        central?.stopScan()
        if peripheralMgr?.isAdvertising == true { peripheralMgr?.stopAdvertising() }
        for p in discovered.values where p.state == .connected { central?.cancelPeripheralConnection(p) }
        queue.async {
            self.discovered.removeAll(); self.clientChars.removeAll(); self.subscribers.removeAll()
            self.reasm.removeAll(); self.seen.removeAll()
            self.emitPeers()
        }
    }

    // 广播一帧内容（原生负责分片/多跳）
    func send(_ payload: Data) {
        queue.async {
            var msgId = Data(count: 8)
            for i in 0..<8 { msgId[i] = UInt8.random(in: 0...255) }
            self.seen[self.hex(msgId)] = Date()   // 自己是源头，避免回环重复
            self.broadcast(payload, msgId: msgId, ttl: self.MAX_TTL)
        }
    }

    // MARK: - 外围（广播 + GATT 服务）
    private func startPeripheralIfReady() {
        guard let pm = peripheralMgr, pm.state == .poweredOn else { return }
        if mutableChar == nil {
            let ch = CBMutableCharacteristic(type: charUUID,
                                             properties: [.write, .writeWithoutResponse, .notify],
                                             value: nil, permissions: [.writeable])
            let svc = CBMutableService(type: serviceUUID, primary: true)
            svc.characteristics = [ch]
            pm.add(svc)
            mutableChar = ch
        }
        if !pm.isAdvertising {
            pm.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID]])
        }
    }

    // MARK: - 中心（扫描 + 连接）
    private func startCentralIfReady() {
        guard let cm = central, cm.state == .poweredOn else { return }
        cm.scanForPeripherals(withServices: [serviceUUID],
                              options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    // MARK: - 分片 / 多跳
    private func broadcast(_ payload: Data, msgId: Data, ttl: Int) {
        let total = max(1, Int(ceil(Double(payload.count) / Double(PAYLOAD))))
        for seq in 0..<total {
            let off = seq * PAYLOAD
            let end = min(off + PAYLOAD, payload.count)
            var frame = Data()
            frame.append(msgId)
            frame.append(UInt8(ttl & 0xFF))
            frame.append(UInt8((seq >> 8) & 0xFF)); frame.append(UInt8(seq & 0xFF))
            frame.append(UInt8((total >> 8) & 0xFF)); frame.append(UInt8(total & 0xFF))
            frame.append(payload.subdata(in: off..<end))
            queue.asyncAfter(deadline: .now() + Double(seq) * 0.015) { [weak self] in
                self?.sendFrameToAll(frame)
            }
        }
    }

    private func sendFrameToAll(_ frame: Data) {
        if let ch = mutableChar, !subscribers.isEmpty {
            peripheralMgr?.updateValue(frame, for: ch, onSubscribedCentrals: nil)
        }
        for (id, ch) in clientChars {
            if let p = discovered[id], p.state == .connected {
                p.writeValue(frame, for: ch, type: .withoutResponse)
            }
        }
    }

    private func onFrameReceived(_ frame: Data) {
        guard frame.count >= HEADER else { return }
        let bytes = [UInt8](frame)
        let msgId = frame.subdata(in: 0..<8)
        let id = hex(msgId)
        if seen[id] != nil { return }
        let ttl = Int(bytes[8])
        let seq = (Int(bytes[9]) << 8) | Int(bytes[10])
        let total = (Int(bytes[11]) << 8) | Int(bytes[12])
        guard total > 0, seq >= 0, seq < total else { return }
        let chunk = frame.subdata(in: HEADER..<frame.count)

        cleanup()
        let r = reasm[id] ?? {
            let n = Reasm(total: total); n.ttl = ttl; n.msgId = msgId; reasm[id] = n; return n
        }()
        if r.chunks[seq] == nil { r.chunks[seq] = chunk; r.received += 1 }
        if r.received == total {
            reasm.removeValue(forKey: id)
            seen[id] = Date()
            var full = Data()
            for c in r.chunks { if let c = c { full.append(c) } }
            let delivered = full
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.delegate?.bleMesh(self, didReceive: delivered)
            }
            if r.ttl > 1 { broadcast(full, msgId: r.msgId, ttl: r.ttl - 1) }
        }
    }

    private func cleanup() {
        let now = Date()
        for (k, v) in reasm where now.timeIntervalSince(v.ts) > REASM_TTL { reasm.removeValue(forKey: k) }
        for (k, v) in seen where now.timeIntervalSince(v) > SEEN_TTL { seen.removeValue(forKey: k) }
    }

    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    private func emitPeers() {
        let count = clientChars.count + subscribers.count
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.delegate?.bleMeshDidUpdatePeers(count)
        }
    }
}

// MARK: - CBCentralManagerDelegate
extension BleMesh: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ cm: CBCentralManager) {
        let available = cm.state == .poweredOn
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.delegate?.bleMeshDidUpdateState(available)
        }
        if running { startCentralIfReady() }
    }
    func centralManager(_ cm: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if discovered[peripheral.identifier] != nil { return }
        discovered[peripheral.identifier] = peripheral
        cm.connect(peripheral, options: nil)
    }
    func centralManager(_ cm: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([serviceUUID])
    }
    func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        discovered.removeValue(forKey: peripheral.identifier)
        clientChars.removeValue(forKey: peripheral.identifier)
        emitPeers()
    }
    func centralManager(_ cm: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        discovered.removeValue(forKey: peripheral.identifier)
    }
}

// MARK: - CBPeripheralDelegate（作为中心时）
extension BleMesh: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else { return }
        peripheral.discoverCharacteristics([charUUID], for: svc)
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let ch = service.characteristics?.first(where: { $0.uuid == charUUID }) else { return }
        clientChars[peripheral.identifier] = ch
        peripheral.setNotifyValue(true, for: ch)
        emitPeers()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let val = characteristic.value { queue.async { self.onFrameReceived(val) } }
    }
}

// MARK: - CBPeripheralManagerDelegate（作为外围时）
extension BleMesh: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if running { startPeripheralIfReady() }
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for req in requests {
            if let val = req.value { queue.async { self.onFrameReceived(val) } }
            peripheral.respond(to: req, withResult: .success)
        }
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didSubscribeTo characteristic: CBCharacteristic) {
        if !subscribers.contains(where: { $0.identifier == central.identifier }) { subscribers.append(central) }
        emitPeers()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                           didUnsubscribeFrom characteristic: CBCharacteristic) {
        subscribers.removeAll { $0.identifier == central.identifier }
        emitPeers()
    }
}
