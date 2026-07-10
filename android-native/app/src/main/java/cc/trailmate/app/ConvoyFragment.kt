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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.MapTileIndex
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.mylocation.GpsMyLocationProvider
import org.osmdroid.views.overlay.mylocation.MyLocationNewOverlay

// 跟车：osmdroid 地图（道路/卫星切换）+ 定位。
class ConvoyFragment : Fragment() {
    private var map: MapView? = null
    private var myLoc: MyLocationNewOverlay? = null

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
        return root
    }

    private fun recenter() {
        val loc = myLoc?.myLocation ?: return
        map?.controller?.animateTo(loc)
        map?.controller?.setZoom(16.0)
    }

    override fun onResume() { super.onResume(); map?.onResume() }
    override fun onPause() { super.onPause(); map?.onPause() }
    override fun onDestroyView() { super.onDestroyView(); myLoc?.disableMyLocation() }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun rowLp() = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(6) }
}
