package cc.trailmate.app

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.fragment.app.Fragment

// 记账 AA 分摊 + 最优结算（Fragment）。
class LedgerFragment : Fragment() {
    private lateinit var store: LedgerStore
    private lateinit var content: TextView

    override fun onCreateView(inflater: LayoutInflater, parent: ViewGroup?, s: Bundle?): View {
        val ctx = requireContext()
        store = LedgerStore(ctx)

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(12))
        }
        root.addView(TextView(ctx).apply { text = "记账 · AA 分摊"; textSize = 22f })

        val btnRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(12), 0, 0) }
        btnRow.addView(Button(ctx).apply { text = "＋ 成员"; setOnClickListener { promptAddMember() } }, rowLp())
        btnRow.addView(Button(ctx).apply { text = "记一笔"; setOnClickListener { promptAddExpense() } }, rowLp())
        btnRow.addView(Button(ctx).apply { text = "备份"; setOnClickListener { promptBackup() } }, rowLp())
        root.addView(btnRow)

        content = TextView(ctx).apply { textSize = 15f; setPadding(0, dp(16), 0, 0); setLineSpacing(dp(4).toFloat(), 1f) }
        root.addView(ScrollView(ctx).apply { addView(content) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        render()
        return root
    }

    // 备份：导出（系统分享，存文件/发微信均可）/ 导入（粘贴 JSON 整体还原）
    private fun promptBackup() {
        AlertDialog.Builder(requireContext())
            .setTitle("账本备份")
            .setItems(arrayOf("导出（分享 JSON）", "导入（粘贴 JSON 还原）")) { _, which ->
                if (which == 0) exportLedger() else promptImport()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun exportLedger() {
        val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "application/json"
            putExtra(android.content.Intent.EXTRA_SUBJECT, "TrailMate 账本备份")
            putExtra(android.content.Intent.EXTRA_TEXT, store.exportJson())
        }
        startActivity(android.content.Intent.createChooser(send, "导出账本"))
    }

    private fun promptImport() {
        val input = EditText(requireContext()).apply {
            hint = "粘贴之前导出的 JSON"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 4
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        AlertDialog.Builder(requireContext())
            .setTitle("导入账本（将整体替换当前账本）").setView(input)
            .setNegativeButton("取消", null)
            .setPositiveButton("导入") { _, _ ->
                val ok = store.importJson(input.text.toString())
                if (ok) render()
                else AlertDialog.Builder(requireContext()).setTitle("导入失败")
                    .setMessage("JSON 格式不对或内容缺字段，当前账本未改动。")
                    .setPositiveButton("好", null).show()
            }.show()
    }

    private fun promptAddMember() {
        val input = EditText(requireContext()).apply { hint = "昵称"; setPadding(dp(16), dp(12), dp(16), dp(12)) }
        AlertDialog.Builder(requireContext())
            .setTitle("添加成员").setView(input)
            .setNegativeButton("取消", null)
            .setPositiveButton("添加") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) { store.addMember(name); render() }
            }.show()
    }

    private fun promptAddExpense() {
        if (store.members.isEmpty()) {
            AlertDialog.Builder(requireContext()).setTitle("先添加成员")
                .setMessage("记账前请先用「＋ 成员」登记同行者。")
                .setPositiveButton("好", null).show()
            return
        }
        val ctx = requireContext()
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(8), dp(16), 0) }
        val titleInput = EditText(ctx).apply { hint = "项目（如 午餐 / 油费）" }
        val amtInput = EditText(ctx).apply { hint = "金额（元）"; inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL }
        box.addView(titleInput); box.addView(amtInput)
        AlertDialog.Builder(ctx).setTitle("记一笔（全体平均分摊）").setView(box)
            .setNegativeButton("取消", null)
            .setPositiveButton("下一步：选付款人") { _, _ ->
                val title = titleInput.text.toString().trim().ifEmpty { "消费" }
                val cents = ((amtInput.text.toString().replace(",", ".").toDoubleOrNull() ?: 0.0) * 100).toInt()
                if (cents > 0) pickPayer(title, cents)
            }.show()
    }

    private fun pickPayer(title: String, cents: Int) {
        val names = store.members.map { it.name }.toTypedArray()
        AlertDialog.Builder(requireContext())
            .setTitle("谁付的款？（¥${Ledger.yuan(cents)}）")
            .setItems(names) { _, which ->
                val payer = store.members[which]
                store.addExpense(title, payer.id, cents, store.members.map { it.id })
                render()
            }.show()
    }

    private fun render() {
        val sb = StringBuilder()
        sb.append("【成员 ${store.members.size}】\n")
        if (store.members.isEmpty()) sb.append("（还没有成员）\n") else store.members.forEach { sb.append("· ${it.name}\n") }
        sb.append("\n【消费明细 · 合计 ¥${Ledger.yuan(Ledger.total(store.expenses))}】\n")
        if (store.expenses.isEmpty()) sb.append("（还没有记账）\n")
        else store.expenses.forEach { e ->
            sb.append("· ${e.title}  ¥${Ledger.yuan(e.amountCents)}  —  ${store.name(e.payerId)} 垫付 · ${e.participantIds.size} 人分摊\n")
        }
        sb.append("\n【结算 · 最优转账】\n")
        val transfers = Ledger.settle(Ledger.netByMember(store.members, store.expenses))
        if (store.expenses.isEmpty()) sb.append("（记账后显示结算方案）\n")
        else if (transfers.isEmpty()) sb.append("账目已平，无需转账 ✓\n")
        else transfers.forEach { t -> sb.append("· ${store.name(t.fromId)}  →  ${store.name(t.toId)}   ¥${Ledger.yuan(t.amountCents)}\n") }
        content.text = sb.toString()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun rowLp() = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = dp(8) }
}
