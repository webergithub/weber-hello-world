package cc.trailmate.app

import android.os.Bundle
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

// 底部导航宿主：记账 / 跟车（后续补 营地蓝牙 / 变声 / 队伍）。
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val container = FrameLayout(this).apply { id = View.generateViewId() }
        val nav = BottomNavigationView(this).apply { inflateMenu(R.menu.bottom_nav) }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(container, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(nav, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        setContentView(root)
        containerId = container.id

        nav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_ledger -> show(LedgerFragment())
                R.id.nav_convoy -> show(ConvoyFragment())
                else -> return@setOnItemSelectedListener false
            }
            true
        }
        if (savedInstanceState == null) show(LedgerFragment())
    }

    private var containerId = 0
    private fun show(f: Fragment) {
        supportFragmentManager.beginTransaction().replace(containerId, f).commit()
    }
}
