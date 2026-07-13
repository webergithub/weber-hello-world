package cc.trailmate.app

import android.os.Bundle
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

// 底部导航宿主：记账 / 跟车 / 营地（后续补 变声 / 队伍）。
class MainActivity : AppCompatActivity() {

    companion object {
        // 固定容器 id：generateViewId() 在旋转/进程恢复时会变，FragmentManager 按旧 id 还原会崩
        private const val CONTAINER_ID = 0x0F0F0001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val container = FrameLayout(this).apply { id = CONTAINER_ID }
        val nav = BottomNavigationView(this).apply { inflateMenu(R.menu.bottom_nav) }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(container, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(nav, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        setContentView(root)

        nav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_ledger -> show(LedgerFragment())
                R.id.nav_convoy -> show(ConvoyFragment())
                R.id.nav_camp -> show(CampFragment())
                else -> return@setOnItemSelectedListener false
            }
            true
        }
        if (savedInstanceState == null) show(LedgerFragment())
    }

    private fun show(f: Fragment) {
        supportFragmentManager.beginTransaction().replace(CONTAINER_ID, f).commit()
    }
}
