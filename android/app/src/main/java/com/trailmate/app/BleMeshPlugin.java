package com.trailmate.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 真实的手机蓝牙自组网插件（BLE Mesh）。
 * 每台设备同时扮演：
 *   - 外围(Peripheral)：广播服务 + 运行 GATT Server，接收邻居写入、向订阅者 notify。
 *   - 中心(Central)：扫描同服务设备并连接，订阅通知、向对端写入。
 * 因而任意两台装了本 App 的手机在蓝牙范围内即可互发消息，无需任何移动网络/WiFi。
 */
@CapacitorPlugin(
    name = "BleMesh",
    permissions = {
        @Permission(alias = "bleS", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT
        }),
        @Permission(alias = "bleLegacy", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION
        })
    }
)
public class BleMeshPlugin extends Plugin {

    private static final UUID SERVICE_UUID = UUID.fromString("7b2f9a10-4c3d-4b8e-9f21-0a1b2c3d4e5f");
    private static final UUID CHAR_UUID = UUID.fromString("7b2f9a11-4c3d-4b8e-9f21-0a1b2c3d4e5f");
    private static final UUID CCC_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int HEADER = 13;      // 8字节msgId + 1字节ttl + 2字节seq + 2字节total
    private static final int PAYLOAD = 180;     // 每帧负载，兼容默认MTU
    private static final long REASM_TTL = 10_000L;
    private static final long SEEN_TTL = 30_000L;   // 去重记录保留时长
    private static final int MAX_TTL = 4;           // 多跳中继最大跳数

    private BluetoothAdapter adapter;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic serverChar;

    private final Map<String, BluetoothDevice> subscribers = new ConcurrentHashMap<>();     // 订阅我通知的中心
    private final Map<String, BluetoothGatt> clients = new ConcurrentHashMap<>();            // 我作为中心连接的对端
    private final Map<String, BluetoothGattCharacteristic> clientChars = new ConcurrentHashMap<>();
    private final Map<String, Reasm> reasm = new HashMap<>();
    private final Map<String, Long> seen = new ConcurrentHashMap<>();   // 多跳去重：已处理过的 msgId

    private HandlerThread bgThread;
    private Handler bg;
    private boolean running = false;
    private final java.util.Random rnd = new java.util.Random();

    private static class Reasm {
        byte[][] chunks;
        int received;
        long ts;
        int ttl;
        byte[] msgId;
    }

    // ---------- 权限 ----------
    private String neededAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bleS" : "bleLegacy";
    }

    private boolean hasPerms() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return granted(Manifest.permission.BLUETOOTH_SCAN)
                && granted(Manifest.permission.BLUETOOTH_ADVERTISE)
                && granted(Manifest.permission.BLUETOOTH_CONNECT);
        }
        return granted(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean granted(String p) {
        return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED;
    }

    // ---------- JS 方法 ----------
    @PluginMethod
    public void initialize(PluginCall call) {
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        adapter = mgr != null ? mgr.getAdapter() : null;
        if (adapter == null) {
            resolveInit(call, false, "unsupported");
            return;
        }
        if (!hasPerms()) {
            requestPermissionForAlias(neededAlias(), call, "permCb");
            return;
        }
        finishInit(call);
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        if (hasPerms()) {
            finishInit(call);
        } else {
            resolveInit(call, false, "unauthorized");
        }
    }

    private void finishInit(PluginCall call) {
        if (!adapter.isEnabled()) {
            resolveInit(call, false, "off");
            return;
        }
        resolveInit(call, true, "on");
    }

    private void resolveInit(PluginCall call, boolean ok, String state) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("state", state);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (running) { call.resolve(); return; }
        if (adapter == null || !adapter.isEnabled() || !hasPerms()) {
            call.reject("蓝牙不可用或未授权");
            return;
        }
        bgThread = new HandlerThread("ble-mesh");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());
        try {
            startGattServer();
            startAdvertising();
            startScanning();
            running = true;
            emitStatus();
            call.resolve();
        } catch (SecurityException e) {
            call.reject("缺少蓝牙权限：" + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        teardown();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        if (data == null) { call.reject("no data"); return; }
        byte[] payload = data.getBytes(StandardCharsets.UTF_8);
        byte[] msgId = new byte[8];
        rnd.nextBytes(msgId);
        markSeen(bytesToHex(msgId, 0, 8));   // 自己是源头，避免回环时重复处理
        broadcast(payload, msgId, MAX_TTL);
        call.resolve();
    }

    // ---------- 外围：GATT Server + 广播 ----------
    private void startGattServer() {
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        gattServer = mgr.openGattServer(getContext(), serverCallback);
        BluetoothGattService svc = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        serverChar = new BluetoothGattCharacteristic(
            CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE
                | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
                | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        );
        BluetoothGattDescriptor ccc = new BluetoothGattDescriptor(
            CCC_UUID,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
        );
        serverChar.addDescriptor(ccc);
        svc.addCharacteristic(serverChar);
        gattServer.addService(svc);
    }

    private void startAdvertising() {
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) return;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(new ParcelUuid(SERVICE_UUID))
            .build();
        advertiser.startAdvertising(settings, data, advCallback);
    }

    private final AdvertiseCallback advCallback = new AdvertiseCallback() {
        @Override public void onStartFailure(int errorCode) { }
    };

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                subscribers.remove(device.getAddress());
                emitStatus();
            }
        }
        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId, BluetoothGattDescriptor descriptor,
                                             boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            // 中心订阅/退订通知
            if (CCC_UUID.equals(descriptor.getUuid())) {
                if (Arrays.equals(value, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    subscribers.put(device.getAddress(), device);
                } else {
                    subscribers.remove(device.getAddress());
                }
                emitStatus();
            }
            if (responseNeeded) {
                try { gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null); } catch (SecurityException ignored) {}
            }
        }
        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic characteristic,
                                                 boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (CHAR_UUID.equals(characteristic.getUuid())) {
                onFrameReceived(value);
            }
            if (responseNeeded) {
                try { gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null); } catch (SecurityException ignored) {}
            }
        }
    };

    // ---------- 中心：扫描 + 连接 ----------
    private void startScanning() {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();
        scanner.startScan(filters, settings, scanCallback);
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String addr = device.getAddress();
            if (clients.containsKey(addr)) return;
            // 去重：地址较大的一方主动作为中心连接，避免双向重复连接
            if (adapter.getAddress() != null && addr.compareTo(adapter.getAddress()) < 0) {
                // 让对方来连我；但地址不可读时仍尝试连接
            }
            try {
                BluetoothGatt gatt = device.connectGatt(getContext(), false, clientCallback, BluetoothDevice.TRANSPORT_LE);
                clients.put(addr, gatt);
            } catch (SecurityException ignored) {}
        }
    };

    private final BluetoothGattCallback clientCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            String addr = gatt.getDevice().getAddress();
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                try { gatt.requestMtu(512); } catch (SecurityException e) { safeDiscover(gatt); }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                clients.remove(addr);
                clientChars.remove(addr);
                try { gatt.close(); } catch (Exception ignored) {}
                emitStatus();
            }
        }
        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            safeDiscover(gatt);
        }
        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            BluetoothGattService svc = gatt.getService(SERVICE_UUID);
            if (svc == null) return;
            BluetoothGattCharacteristic ch = svc.getCharacteristic(CHAR_UUID);
            if (ch == null) return;
            clientChars.put(gatt.getDevice().getAddress(), ch);
            try {
                gatt.setCharacteristicNotification(ch, true);
                BluetoothGattDescriptor ccc = ch.getDescriptor(CCC_UUID);
                if (ccc != null) {
                    ccc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    gatt.writeDescriptor(ccc);
                }
            } catch (SecurityException ignored) {}
            emitStatus();
        }
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            if (CHAR_UUID.equals(characteristic.getUuid())) {
                onFrameReceived(characteristic.getValue());
            }
        }
    };

    private void safeDiscover(BluetoothGatt gatt) {
        try { gatt.discoverServices(); } catch (SecurityException ignored) {}
    }

    // ---------- 分片发送 / 重组 / 多跳中继 ----------
    private void broadcast(byte[] payload, byte[] msgId, int ttl) {
        if (bg == null) return;
        final int total = Math.max(1, (int) Math.ceil(payload.length / (double) PAYLOAD));
        for (int seq = 0; seq < total; seq++) {
            final int s = seq;
            final int off = seq * PAYLOAD;
            final int len = Math.min(PAYLOAD, payload.length - off);
            final byte[] frame = new byte[HEADER + len];
            System.arraycopy(msgId, 0, frame, 0, 8);
            frame[8] = (byte) (ttl & 0xFF);
            frame[9] = (byte) (s >> 8); frame[10] = (byte) s;
            frame[11] = (byte) (total >> 8); frame[12] = (byte) total;
            System.arraycopy(payload, off, frame, HEADER, len);
            // 轻量节流，避免拥塞（尽力而为的营地 Mesh）
            bg.postDelayed(() -> sendFrameToAll(frame), s * 15L);
        }
    }

    private void sendFrameToAll(byte[] frame) {
        // 通知所有订阅我的中心
        if (gattServer != null && serverChar != null) {
            for (BluetoothDevice dev : subscribers.values()) {
                try {
                    serverChar.setValue(frame);
                    gattServer.notifyCharacteristicChanged(dev, serverChar, false);
                } catch (SecurityException ignored) {}
            }
        }
        // 写入所有我连接的对端
        for (Map.Entry<String, BluetoothGatt> e : clients.entrySet()) {
            BluetoothGattCharacteristic ch = clientChars.get(e.getKey());
            if (ch == null) continue;
            try {
                ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                ch.setValue(frame);
                e.getValue().writeCharacteristic(ch);
            } catch (SecurityException ignored) {}
        }
    }

    private void onFrameReceived(byte[] frame) {
        if (frame == null || frame.length < HEADER) return;
        String id = bytesToHex(frame, 0, 8);
        if (seen.containsKey(id)) return;   // 多跳去重：已处理过的消息直接丢弃
        int ttl = frame[8] & 0xFF;
        int seq = ((frame[9] & 0xFF) << 8) | (frame[10] & 0xFF);
        int total = ((frame[11] & 0xFF) << 8) | (frame[12] & 0xFF);
        if (total <= 0 || seq < 0 || seq >= total) return;
        byte[] chunk = Arrays.copyOfRange(frame, HEADER, frame.length);
        byte[] full = null;
        int relayTtl = 0;
        synchronized (reasm) {
            cleanupReasm();
            Reasm r = reasm.get(id);
            if (r == null) {
                r = new Reasm();
                r.chunks = new byte[total][];
                r.ts = System.currentTimeMillis();
                r.ttl = ttl;
                r.msgId = Arrays.copyOfRange(frame, 0, 8);
                reasm.put(id, r);
            }
            if (r.chunks[seq] == null) {
                r.chunks[seq] = chunk;
                r.received++;
            }
            if (r.received == total) {
                reasm.remove(id);
                markSeen(id);
                int size = 0;
                for (byte[] c : r.chunks) size += c.length;
                full = new byte[size];
                int off = 0;
                for (byte[] c : r.chunks) { System.arraycopy(c, 0, full, off, c.length); off += c.length; }
                relayTtl = r.ttl;
            }
        }
        if (full != null) {
            emitMessage(new String(full, StandardCharsets.UTF_8));
            // 多跳中继：跳数递减后仍 > 0，则转发给其它邻居（去重保证不会风暴）
            if (relayTtl > 1) {
                byte[] msgId = Arrays.copyOfRange(frame, 0, 8);
                broadcast(full, msgId, relayTtl - 1);
            }
        }
    }

    private void markSeen(String id) {
        seen.put(id, System.currentTimeMillis());
    }

    private void cleanupReasm() {
        long now = System.currentTimeMillis();
        List<String> drop = new ArrayList<>();
        for (Map.Entry<String, Reasm> e : reasm.entrySet()) {
            if (now - e.getValue().ts > REASM_TTL) drop.add(e.getKey());
        }
        for (String k : drop) reasm.remove(k);
        List<String> ds = new ArrayList<>();
        for (Map.Entry<String, Long> e : seen.entrySet()) {
            if (now - e.getValue() > SEEN_TTL) ds.add(e.getKey());
        }
        for (String k : ds) seen.remove(k);
    }

    private static String bytesToHex(byte[] b, int off, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = off; i < off + len; i++) sb.append(String.format("%02x", b[i]));
        return sb.toString();
    }

    // ---------- 事件 ----------
    private void emitMessage(String data) {
        JSObject ev = new JSObject();
        ev.put("data", data);
        notifyListeners("message", ev);
    }

    private void emitStatus() {
        JSObject ev = new JSObject();
        ev.put("state", running ? "on" : "off");
        ev.put("peers", subscribers.size() + clients.size());
        notifyListeners("status", ev);
    }

    private void teardown() {
        running = false;
        try { if (advertiser != null) advertiser.stopAdvertising(advCallback); } catch (Exception ignored) {}
        try { if (scanner != null) scanner.stopScan(scanCallback); } catch (Exception ignored) {}
        for (BluetoothGatt g : clients.values()) { try { g.close(); } catch (Exception ignored) {} }
        clients.clear(); clientChars.clear();
        subscribers.clear();
        synchronized (reasm) { reasm.clear(); }
        seen.clear();
        try { if (gattServer != null) gattServer.close(); } catch (Exception ignored) {}
        gattServer = null;
        if (bgThread != null) { bgThread.quitSafely(); bgThread = null; bg = null; }
    }

    @Override
    protected void handleOnDestroy() {
        teardown();
    }
}
