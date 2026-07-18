import Foundation
import Capacitor
import CoreBluetooth

/**
 * 真实的手机蓝牙自组网插件（BLE Mesh）—— iOS / CoreBluetooth 实现。
 * 每台设备同时作为 外围(CBPeripheralManager, 广播+GATT服务) 与 中心(CBCentralManager, 扫描+连接)，
 * 蓝牙范围内的两台手机即可互发消息，无需移动网络/WiFi。
 * 与 Android 端使用相同的 Service/Characteristic UUID 与分片协议，双平台互通。
 */
@objc(BleMeshPlugin)
public class BleMeshPlugin: CAPPlugin, CAPBridgedPlugin,
    CBCentralManagerDelegate, CBPeripheralManagerDelegate, CBPeripheralDelegate {

    public let identifier = "BleMeshPlugin"
    public let jsName = "BleMesh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise)
    ]

    private let serviceUUID = CBUUID(string: "7B2F9A10-4C3D-4B8E-9F21-0A1B2C3D4E5F")
    private let charUUID = CBUUID(string: "7B2F9A11-4C3D-4B8E-9F21-0A1B2C3D4E5F")

    private let HEADER = 13
    private let PAYLOAD = 180
    private let REASM_TTL: TimeInterval = 10
    private let SEEN_TTL: TimeInterval = 30   // 去重记录保留时长
    private let MAX_TTL = 4                    // 多跳中继最大跳数

    private var central: CBCentralManager?
    private var peripheralMgr: CBPeripheralManager?
    private var mutableChar: CBMutableCharacteristic?

    private var discovered: [UUID: CBPeripheral] = [:]         // 强引用，防止被释放
    private var clientChars: [UUID: CBCharacteristic] = [:]    // 我作为中心可写入的对端特征
    private var subscribers: [CBCentral] = []                  // 订阅我通知的中心
    private var reasm: [String: Reasm] = [:]
    private var seen: [String: Date] = [:]                     // 多跳去重：已处理过的 msgId

    private var running = false
    private let queue = DispatchQueue(label: "ble.mesh.queue")

    private class Reasm {
        var chunks: [Data?]
        var received = 0
        var ts = Date()
        var ttl = 0
        var msgId = Data()
        init(total: Int) { chunks = Array(repeating: nil, count: total) }
    }

    // MARK: - JS 方法
    @objc func initialize(_ call: CAPPluginCall) {
        if central == nil {
            central = CBCentralManager(delegate: self, queue: queue)
        }
        if peripheralMgr == nil {
            peripheralMgr = CBPeripheralManager(delegate: self, queue: queue)
        }
        let auth = CBManager.authorization
        if auth == .denied || auth == .restricted {
            call.resolve(["ok": false, "state": "unauthorized"])
        } else {
            // 具体上电状态通过 delegate 异步到达；这里乐观返回，start 时才真正广播/扫描
            call.resolve(["ok": true, "state": "on"])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        running = true
        startPeripheralIfReady()
        startCentralIfReady()
        emitStatus()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        running = false
        central?.stopScan()
        if peripheralMgr?.isAdvertising == true { peripheralMgr?.stopAdvertising() }
        for p in discovered.values where p.state == .connected {
            central?.cancelPeripheralConnection(p)
        }
        discovered.removeAll()
        clientChars.removeAll()
        subscribers.removeAll()
        queue.async { [weak self] in
            self?.reasm.removeAll()
            self?.seen.removeAll()
        }
        call.resolve()
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let data = call.getString("data") else { call.reject("no data"); return }
        let payload = Data(data.utf8)
        queue.async { [weak self] in
            guard let self = self else { return }
            var msgId = Data(count: 8)
            for i in 0..<8 { msgId[i] = UInt8.random(in: 0...255) }
            self.seen[self.hex(msgId)] = Date()   // 自己是源头，避免回环重复处理
            self.broadcast(payload, msgId: msgId, ttl: self.MAX_TTL)
        }
        call.resolve()
    }

    // MARK: - 外围（广播 + GATT 服务）
    private func startPeripheralIfReady() {
        guard let pm = peripheralMgr, pm.state == .poweredOn else { return }
        if mutableChar == nil {
            let ch = CBMutableCharacteristic(
                type: charUUID,
                properties: [.write, .writeWithoutResponse, .notify],
                value: nil,
                permissions: [.writeable]
            )
            let svc = CBMutableService(type: serviceUUID, primary: true)
            svc.characteristics = [ch]
            pm.add(svc)
            mutableChar = ch
        }
        if !pm.isAdvertising {
            pm.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceUUID]])
        }
    }

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if running { startPeripheralIfReady() }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for req in requests {
            if let val = req.value { onFrameReceived(val) }
            peripheral.respond(to: req, withResult: .success)
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                                  didSubscribeTo characteristic: CBCharacteristic) {
        if !subscribers.contains(where: { $0.identifier == central.identifier }) {
            subscribers.append(central)
        }
        emitStatus()
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                                  didUnsubscribeFrom characteristic: CBCharacteristic) {
        subscribers.removeAll { $0.identifier == central.identifier }
        emitStatus()
    }

    // MARK: - 中心（扫描 + 连接）
    private func startCentralIfReady() {
        guard let cm = central, cm.state == .poweredOn else { return }
        cm.scanForPeripherals(withServices: [serviceUUID],
                              options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    public func centralManagerDidUpdateState(_ cm: CBCentralManager) {
        if running { startCentralIfReady() }
    }

    public func centralManager(_ cm: CBCentralManager, didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if discovered[peripheral.identifier] != nil { return }
        discovered[peripheral.identifier] = peripheral
        cm.connect(peripheral, options: nil)
    }

    public func centralManager(_ cm: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([serviceUUID])
    }

    public func centralManager(_ cm: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                               error: Error?) {
        discovered.removeValue(forKey: peripheral.identifier)
        clientChars.removeValue(forKey: peripheral.identifier)
        emitStatus()
        // 断线后若仍在运行，重新纳入扫描（扫描持续进行，会再次发现）
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else { return }
        peripheral.discoverCharacteristics([charUUID], for: svc)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                           error: Error?) {
        guard let ch = service.characteristics?.first(where: { $0.uuid == charUUID }) else { return }
        clientChars[peripheral.identifier] = ch
        peripheral.setNotifyValue(true, for: ch)
        emitStatus()
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                           error: Error?) {
        if let val = characteristic.value { onFrameReceived(val) }
    }

    // MARK: - 分片发送 / 重组
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
            let delay = Double(seq) * 0.015
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.sendFrameToAll(frame)
            }
        }
    }

    private func sendFrameToAll(_ frame: Data) {
        // 通知订阅我的中心
        if let ch = mutableChar, !subscribers.isEmpty {
            peripheralMgr?.updateValue(frame, for: ch, onSubscribedCentrals: nil)
        }
        // 写入我连接的对端
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
        if seen[id] != nil { return }   // 多跳去重：已处理过的消息直接丢弃
        let ttl = Int(bytes[8])
        let seq = (Int(bytes[9]) << 8) | Int(bytes[10])
        let total = (Int(bytes[11]) << 8) | Int(bytes[12])
        guard total > 0, seq >= 0, seq < total else { return }
        let chunk = frame.subdata(in: HEADER..<frame.count)

        cleanupReasm()
        let r = reasm[id] ?? {
            let n = Reasm(total: total); n.ttl = ttl; n.msgId = msgId; reasm[id] = n; return n
        }()
        if r.chunks[seq] == nil {
            r.chunks[seq] = chunk
            r.received += 1
        }
        if r.received == total {
            reasm.removeValue(forKey: id)
            seen[id] = Date()
            var full = Data()
            for c in r.chunks { if let c = c { full.append(c) } }
            if let str = String(data: full, encoding: .utf8) {
                emitMessage(str)
            }
            // 多跳中继：跳数递减后仍 > 0，则转发给其它邻居（去重保证不会风暴）
            if r.ttl > 1 {
                broadcast(full, msgId: r.msgId, ttl: r.ttl - 1)
            }
        }
    }

    private func hex(_ d: Data) -> String {
        return d.map { String(format: "%02x", $0) }.joined()
    }

    private func cleanupReasm() {
        let now = Date()
        for (k, v) in reasm where now.timeIntervalSince(v.ts) > REASM_TTL {
            reasm.removeValue(forKey: k)
        }
        for (k, v) in seen where now.timeIntervalSince(v) > SEEN_TTL {
            seen.removeValue(forKey: k)
        }
    }

    // MARK: - 事件
    private func emitMessage(_ data: String) {
        notifyListeners("message", data: ["data": data])
    }

    private func emitStatus() {
        let connected = clientChars.count
        notifyListeners("status", data: ["state": running ? "on" : "off",
                                         "peers": subscribers.count + connected])
    }
}
