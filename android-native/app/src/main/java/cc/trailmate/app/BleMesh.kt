package cc.trailmate.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.ceil
import kotlin.random.Random

/**
 * 蓝牙自组网（BLE Mesh）—— Kotlin 原生实现。
 * 每台设备同时作 外围(广播+GATT服务) 与 中心(扫描+连接)；多跳 TTL 泛洪 + msgId 去重 + 分片重组。
 * 与 iOS 原生版 BleMesh.swift、Capacitor 版 BleMeshPlugin 使用**相同的 UUID 与帧协议**，跨平台互通：
 *   帧头 13 字节 = 8 msgId + 1 ttl + 2 seq + 2 total。
 * 权限由调用方（Fragment）先行申请；此处统一 try/catch SecurityException 兜底。
 */
@SuppressLint("MissingPermission")
class BleMesh(private val ctx: Context) {

    interface Listener {
        fun onMeshMessage(payload: ByteArray)   // 主线程回调
        fun onMeshPeers(count: Int)             // 主线程回调
    }

    var listener: Listener? = null

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("7b2f9a10-4c3d-4b8e-9f21-0a1b2c3d4e5f")
        val CHAR_UUID: UUID = UUID.fromString("7b2f9a11-4c3d-4b8e-9f21-0a1b2c3d4e5f")
        val CCC_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val HEADER = 13
        const val PAYLOAD = 180
        const val REASM_TTL_MS = 10_000L
        const val SEEN_TTL_MS = 30_000L
        const val MAX_TTL = 4
    }

    private val mainHandler = Handler(ctx.mainLooper)
    private var bgThread: HandlerThread? = null
    private var bg: Handler? = null

    private val manager get() = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private var gattServer: BluetoothGattServer? = null
    private var serverChar: BluetoothGattCharacteristic? = null

    private val subscribers = ConcurrentHashMap<String, BluetoothDevice>()
    private val clients = ConcurrentHashMap<String, BluetoothGatt>()
    private val clientChars = ConcurrentHashMap<String, BluetoothGattCharacteristic>()

    private class Reasm(total: Int) {
        val chunks = arrayOfNulls<ByteArray>(total)
        var received = 0
        val ts = System.currentTimeMillis()
        var ttl = 0
        var msgId = ByteArray(8)
    }

    private val reasm = HashMap<String, Reasm>()
    private val seen = ConcurrentHashMap<String, Long>()
    private var running = false

    // MARK: - 生命周期
    fun start(): Boolean {
        if (running) return true
        val adapter = manager.adapter ?: return false
        if (!adapter.isEnabled) return false
        val t = HandlerThread("ble-mesh").also { it.start() }
        bgThread = t
        bg = Handler(t.looper)
        return try {
            startGattServer()
            startAdvertising()
            startScanning()
            running = true
            emitPeers()
            true
        } catch (_: SecurityException) {
            false
        }
    }

    fun stop() {
        running = false
        mainH.removeCallbacks(scanCycle)
        stopScanOnly()
        try { manager.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advCallback) } catch (_: Exception) {}
        clients.values.forEach { runCatching { it.close() } }
        clients.clear(); clientChars.clear(); subscribers.clear()
        synchronized(reasm) { reasm.clear() }
        seen.clear()
        runCatching { gattServer?.close() }
        gattServer = null
        bgThread?.quitSafely(); bgThread = null; bg = null
        emitPeers()
    }

    /** 广播一帧内容（负责分片/多跳）。 */
    fun send(payload: ByteArray) {
        val h = bg ?: return
        h.post {
            val msgId = Random.nextBytes(8)
            seen[hex(msgId)] = System.currentTimeMillis()   // 源头自标记，避免回环
            broadcast(payload, msgId, MAX_TTL)
        }
    }

    // MARK: - 外围（GATT Server + 广播）
    private fun startGattServer() {
        val server = manager.openGattServer(ctx, serverCallback) ?: return
        val ch = BluetoothGattCharacteristic(
            CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        ch.addDescriptor(
            BluetoothGattDescriptor(
                CCC_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
            )
        )
        val svc = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        svc.addCharacteristic(ch)
        server.addService(svc)
        gattServer = server
        serverChar = ch
    }

    private fun startAdvertising() {
        val advertiser = manager.adapter.bluetoothLeAdvertiser ?: return
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()
        advertiser.startAdvertising(settings, data, advCallback)
    }

    private val advCallback = object : AdvertiseCallback() {}

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                subscribers.remove(device.address)
                emitPeers()
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray
        ) {
            if (CCC_UUID == descriptor.uuid) {
                if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    subscribers[device.address] = device
                } else {
                    subscribers.remove(device.address)
                }
                emitPeers()
            }
            if (responseNeeded) {
                runCatching { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray
        ) {
            if (CHAR_UUID == characteristic.uuid) bg?.post { onFrameReceived(value) }
            if (responseNeeded) {
                runCatching { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) }
            }
        }
    }

    // MARK: - 中心（扫描 + 连接）· 占空比省电（G-ENG-2）
    // 无邻居时持续扫描（保证快速发现）；已有连接后转 8s 扫 / 16s 停 循环——
    // 新邻居仍能在下个扫描窗被发现，扫描耗电约降为 1/3。
    private var scanActive = false
    private val mainH = android.os.Handler(android.os.Looper.getMainLooper())
    private val scanCycle = object : Runnable {
        override fun run() {
            if (!running) return
            val peers = clientChars.size + subscribers.size
            if (scanActive && peers > 0) {
                stopScanOnly()
                mainH.postDelayed(this, 16_000)
            } else {
                startScanOnly()
                mainH.postDelayed(this, 8_000)
            }
        }
    }

    private fun startScanning() { mainH.post(scanCycle) }

    private fun startScanOnly() {
        if (scanActive) return
        val scanner = manager.adapter.bluetoothLeScanner ?: return
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        try { scanner.startScan(filters, settings, scanCallback); scanActive = true } catch (_: Exception) {}
    }

    private fun stopScanOnly() {
        if (!scanActive) return
        try { manager.adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
        scanActive = false
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            if (clients.containsKey(device.address)) return
            try {
                val gatt = device.connectGatt(ctx, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
                clients[device.address] = gatt
            } catch (_: SecurityException) {}
        }
    }

    private val clientCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val addr = gatt.device.address
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                try { gatt.requestMtu(512) } catch (_: SecurityException) { runCatching { gatt.discoverServices() } }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                clients.remove(addr)
                clientChars.remove(addr)
                runCatching { gatt.close() }
                emitPeers()
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            runCatching { gatt.discoverServices() }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val svc = gatt.getService(SERVICE_UUID) ?: return
            val ch = svc.getCharacteristic(CHAR_UUID) ?: return
            clientChars[gatt.device.address] = ch
            try {
                gatt.setCharacteristicNotification(ch, true)
                ch.getDescriptor(CCC_UUID)?.let { ccc ->
                    @Suppress("DEPRECATION")
                    ccc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(ccc)
                }
            } catch (_: SecurityException) {}
            emitPeers()
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (CHAR_UUID == characteristic.uuid) {
                val v = characteristic.value ?: return
                bg?.post { onFrameReceived(v) }
            }
        }
    }

    // MARK: - 分片发送 / 重组 / 多跳
    private fun broadcast(payload: ByteArray, msgId: ByteArray, ttl: Int) {
        val h = bg ?: return
        val total = maxOf(1, ceil(payload.size / PAYLOAD.toDouble()).toInt())
        for (seq in 0 until total) {
            val off = seq * PAYLOAD
            val len = minOf(PAYLOAD, payload.size - off)
            val frame = ByteArray(HEADER + len)
            System.arraycopy(msgId, 0, frame, 0, 8)
            frame[8] = (ttl and 0xFF).toByte()
            frame[9] = (seq shr 8).toByte(); frame[10] = seq.toByte()
            frame[11] = (total shr 8).toByte(); frame[12] = total.toByte()
            System.arraycopy(payload, off, frame, HEADER, len)
            h.postDelayed({ sendFrameToAll(frame) }, seq * 15L)
        }
    }

    private fun sendFrameToAll(frame: ByteArray) {
        val server = gattServer
        val ch = serverChar
        if (server != null && ch != null) {
            for (dev in subscribers.values) {
                try {
                    @Suppress("DEPRECATION")
                    ch.value = frame
                    @Suppress("DEPRECATION")
                    server.notifyCharacteristicChanged(dev, ch, false)
                } catch (_: SecurityException) {}
            }
        }
        for ((addr, gatt) in clients) {
            val c = clientChars[addr] ?: continue
            try {
                c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                @Suppress("DEPRECATION")
                c.value = frame
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(c)
            } catch (_: SecurityException) {}
        }
    }

    private fun onFrameReceived(frame: ByteArray) {
        if (frame.size < HEADER) return
        val id = hex(frame.copyOfRange(0, 8))
        if (seen.containsKey(id)) return
        val ttl = frame[8].toInt() and 0xFF
        val seq = ((frame[9].toInt() and 0xFF) shl 8) or (frame[10].toInt() and 0xFF)
        val total = ((frame[11].toInt() and 0xFF) shl 8) or (frame[12].toInt() and 0xFF)
        if (total <= 0 || seq < 0 || seq >= total) return
        val chunk = frame.copyOfRange(HEADER, frame.size)

        var full: ByteArray? = null
        var relayTtl = 0
        var relayId = ByteArray(0)
        synchronized(reasm) {
            cleanup()
            val r = reasm.getOrPut(id) {
                Reasm(total).also { it.ttl = ttl; it.msgId = frame.copyOfRange(0, 8) }
            }
            if (r.chunks[seq] == null) {
                r.chunks[seq] = chunk
                r.received++
            }
            if (r.received == total) {
                reasm.remove(id)
                seen[id] = System.currentTimeMillis()
                val size = r.chunks.sumOf { it?.size ?: 0 }
                val out = ByteArray(size)
                var off = 0
                for (c in r.chunks) { c ?: continue; System.arraycopy(c, 0, out, off, c.size); off += c.size }
                full = out
                relayTtl = r.ttl
                relayId = r.msgId
            }
        }
        full?.let { data ->
            mainHandler.post { listener?.onMeshMessage(data) }
            if (relayTtl > 1) broadcast(data, relayId, relayTtl - 1)   // 多跳中继（去重防风暴）
        }
    }

    private fun cleanup() {
        val now = System.currentTimeMillis()
        reasm.entries.removeAll { now - it.value.ts > REASM_TTL_MS }
        seen.entries.removeAll { now - it.value > SEEN_TTL_MS }
    }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun emitPeers() {
        val count = subscribers.size + clientChars.size
        mainHandler.post { listener?.onMeshPeers(count) }
    }
}
