package cc.trailmate.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.os.Handler
import android.os.Looper
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import org.json.JSONObject
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.util.MapTileIndex
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.mylocation.GpsMyLocationProvider
import org.osmdroid.views.overlay.mylocation.MyLocationNewOverlay

// 跟车：osmdroid 地图（道路/卫星切换）+ 定位 + 经蓝牙 Mesh 与同行者互见位置（含 iOS 同伴，离线可用）。
class ConvoyFragment : Fragment() {
    private var map: MapView? = null
    private var myLoc: MyLocationNewOverlay? = null
    private var health: android.widget.TextView? = null
    private val peerMarkers = HashMap<String, Marker>()
    private val ticker = Handler(Looper.getMainLooper())
    private val broadcastLoop = object : Runnable {
        override fun run() {
            broadcastMyLocation()
            renderHealth()                   // 上报健康可见（G-DR-1）：随广播节拍刷新
            ticker.postDelayed(this, 3000)   // 节流：每 3 秒广播一次
        }
    }

    // 位置共享链路健康（G-DR-1）：蓝牙关/无邻居时如实告知，不让用户以为同伴能看到自己
    private fun renderHealth() {
        val ctx = context ?: return
        val tv = health ?: return
        val adapter = (ctx.getSystemService(android.content.Context.BLUETOOTH_SERVICE)
            as? android.bluetooth.BluetoothManager)?.adapter
        when {
            adapter == null || !adapter.isEnabled -> {
                tv.visibility = View.VISIBLE
                tv.text = "⚠️ 蓝牙已关闭，位置无法共享给同伴"
            }
            MeshBus.peerCount == 0 -> {
                tv.visibility = View.VISIBLE
                tv.text = "附近无蓝牙邻居，同伴暂看不到你的位置"
            }
            else -> tv.visibility = View.GONE
        }
    }

    // 卫星瓦片源（ESRI World Imagery，无需 key）
    private val esri = object : OnlineTileSourceBase(
        "ESRI-Sat", 0, 19, 256, ".jpg",
        arrayOf("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/")
    ) {
        override fun getTileURLString(pMapTileIndex: Long): String =
            baseUrl + MapTileIndex.getZoom(pMapTileIndex) + "/" +
                MapTileIndex.getY(pMapTileIndex) + "/" + MapTileIndex.getX(pMapTileIndex)
    }

    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) myLoc?.enableMyLocation()
    }

    override fun onCreateView(inflater: LayoutInflater, parent: ViewGroup?, s: Bundle?): View {
        val ctx = requireContext()
        Configuration.getInstance().userAgentValue = ctx.packageName

        val root = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }

        val bar = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(8), dp(8), dp(8), dp(4)) }
        val road = Button(ctx).apply { text = "道路"; setOnClickListener { map?.setTileSource(TileSourceFactory.MAPNIK) } }
        val sat = Button(ctx).apply { text = "卫星"; setOnClickListener { map?.setTileSource(esri) } }
        val here = Button(ctx).apply { text = "定位"; setOnClickListener { recenter() } }
        bar.addView(road, rowLp()); bar.addView(sat, rowLp()); bar.addView(here, rowLp())
        root.addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        health = android.widget.TextView(ctx).apply {
            textSize = 13f
            setTextColor(0xFFB45309.toInt())
            setPadding(dp(8), 0, dp(8), dp(4))
            visibility = View.GONE
        }
        root.addView(health, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        val m = MapView(ctx)
        m.setTileSource(TileSourceFactory.MAPNIK)
        m.setMultiTouchControls(true)
        m.controller.setZoom(13.0)
        map = m
        root.addView(m, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        val overlay = MyLocationNewOverlay(GpsMyLocationProvider(ctx), m)
        m.overlays.add(overlay)
        myLoc = overlay

        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            overlay.enableMyLocation()
        } else {
            permLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        overlay.runOnFirstFix {
            activity?.runOnUiThread {
                overlay.myLocation?.let { m.controller.animateTo(it); m.controller.setZoom(16.0) }
            }
        }

        // 蓝牙 Mesh：订阅同行者位置（同队伍码；跨 iOS/安卓）。
        // 每次重建都注册：MeshBus 为"每类型单 handler"，新实例自动顶替旧实例。
        MeshBus.subscribe(MeshBus.KIND_LOC) { body -> onPeerLocation(body) }
        MeshBus.start(ctx)   // 幂等；蓝牙权限未授时静默失败，营地页会引导授权
        return root
    }

    private fun broadcastMyLocation() {
        val ctx = context ?: return
        val loc = myLoc?.myLocation ?: return
        val json = JSONObject()
            .put("id", Identity.deviceId(ctx)).put("n", Identity.nick(ctx))
            .put("lat", loc.latitude).put("lng", loc.longitude)
            .put("ts", System.currentTimeMillis() / 1000.0)
        MeshBus.send(MeshBus.KIND_LOC, json.toString().toByteArray(Charsets.UTF_8))
    }

    private fun onPeerLocation(body: ByteArray) {
        val ctx = context ?: return
        val m = map ?: return
        try {
            val o = JSONObject(String(body, Charsets.UTF_8))
            val id = o.getString("id")
            if (id == Identity.deviceId(ctx)) return
            val point = GeoPoint(o.getDouble("lat"), o.getDouble("lng"))
            val marker = peerMarkers.getOrPut(id) {
                Marker(m).also {
                    it.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                    m.overlays.add(it)
                }
            }
            marker.position = point
            marker.title = o.optString("n", "同伴")
            m.invalidate()
        } catch (_: Exception) {}
    }

    private fun recenter() {
        val loc = myLoc?.myLocation ?: return
        map?.controller?.animateTo(loc)
        map?.controller?.setZoom(16.0)
    }

    override fun onResume() {
        super.onResume(); map?.onResume(); ticker.post(broadcastLoop)
    }
    override fun onPause() {
        super.onPause(); map?.onPause(); ticker.removeCallbacks(broadcastLoop)
    }
    override fun onDestroyView() {
        super.onDestroyView(); ticker.removeCallbacks(broadcastLoop)
        myLoc?.disableMyLocation(); peerMarkers.clear()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun rowLp() = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(6) }
}
