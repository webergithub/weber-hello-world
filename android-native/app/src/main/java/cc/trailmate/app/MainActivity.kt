package cc.trailmate.app

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

// 里程碑1（Android 原生）：记账 AA 分摊 + 最优结算。后续里程碑补 跟车/营地蓝牙/变声/队伍。
class MainActivity : AppCompatActivity() {
    private lateinit var store: LedgerStore
    private lateinit var content: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = LedgerStore(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(24), dp(16), dp(16))
        }
        root.addView(TextView(this).apply { text = "TrailMate · 记账 AA 分摊"; textSize = 22f })

        val btnRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(12), 0, 0) }
        btnRow.addView(Button(this).apply { text = "＋ 成员"; setOnClickListener { promptAddMember() } }, rowLp())
        btnRow.addView(Button(this).apply { text = "记一笔"; setOnClickListener { promptAddExpense() } }, rowLp())
        root.addView(btnRow)

        content = TextView(this).apply { textSize = 15f; setPadding(0, dp(16), 0, 0); setLineSpacing(dp(4).toFloat(), 1f) }
        val scroll = ScrollView(this).apply { addView(content) }
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        setContentView(root)
        render()
    }

    private fun promptAddMember() {
        val input = EditText(this).apply { hint = "昵称"; setPadding(dp(16), dp(12), dp(16), dp(12)) }
        AlertDialog.Builder(this)
            .setTitle("添加成员")
            .setView(input)
            .setNegativeButton("取消", null)
            .setPositiveButton("添加") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) { store.addMember(name); render() }
            }
            .show()
    }

    private fun promptAddExpense() {
        if (store.members.isEmpty()) {
            AlertDialog.Builder(this).setTitle("先添加成员")
                .setMessage("记账前请先用「＋ 成员」登记同行者。")
                .setPositiveButton("好", null).show()
            return
        }
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(8), dp(16), 0) }
        val titleInput = EditText(this).apply { hint = "项目（如 午餐 / 油费）" }
        val amtInput = EditText(this).apply { hint = "金额（元）"; inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL }
        box.addView(titleInput); box.addView(amtInput)
        AlertDialog.Builder(this)
            .setTitle("记一笔（全体平均分摊）")
            .setView(box)
            .setNegativeButton("取消", null)
            .setPositiveButton("下一步：选付款人") { _, _ ->
                val title = titleInput.text.toString().trim().ifEmpty { "消费" }
                val cents = ((amtInput.text.toString().replace(",", ".").toDoubleOrNull() ?: 0.0) * 100).toInt()
                if (cents > 0) pickPayer(title, cents)
            }
            .show()
    }

    private fun pickPayer(title: String, cents: Int) {
        val names = store.members.map { it.name }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("谁付的款？（¥${Ledger.yuan(cents)}）")
            .setItems(names) { _, which ->
                val payer = store.members[which]
                store.addExpense(title, payer.id, cents, store.members.map { it.id })
                render()
            }
            .show()
    }

    private fun render() {
        val sb = StringBuilder()
        sb.append("【成员 ${store.members.size}】\n")
        if (store.members.isEmpty()) sb.append("（还没有成员）\n")
        else store.members.forEach { sb.append("· ${it.name}\n") }

        sb.append("\n【消费明细 · 合计 ¥${Ledger.yuan(Ledger.total(store.expenses))}】\n")
        if (store.expenses.isEmpty()) sb.append("（还没有记账）\n")
        else store.expenses.forEach { e ->
            sb.append("· ${e.title}  ¥${Ledger.yuan(e.amountCents)}  —  ${store.name(e.payerId)} 垫付 · ${e.participantIds.size} 人分摊\n")
        }

        sb.append("\n【结算 · 最优转账】\n")
        val net = Ledger.netByMember(store.members, store.expenses)
        val transfers = Ledger.settle(net)
        if (store.expenses.isEmpty()) sb.append("（记账后显示结算方案）\n")
        else if (transfers.isEmpty()) sb.append("账目已平，无需转账 ✓\n")
        else transfers.forEach { t ->
            sb.append("· ${store.name(t.fromId)}  →  ${store.name(t.toId)}   ¥${Ledger.yuan(t.amountCents)}\n")
        }

        content.text = sb.toString()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun rowLp() = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) }
}
