package cc.trailmate.app

// 记账领域模型 + AA 结算（纯逻辑，与 iOS 版一致）。金额用「分」整数。

data class Member(val id: String, val name: String)
data class Expense(
    val id: String,
    val title: String,
    val payerId: String,
    val amountCents: Int,
    val participantIds: List<String>
)
data class Transfer(val fromId: String, val toId: String, val amountCents: Int)

object Ledger {
    fun shares(e: Expense): Map<String, Int> {
        val ids = e.participantIds
        if (ids.isEmpty()) return emptyMap()
        val base = e.amountCents / ids.size
        var allocated = 0
        val r = LinkedHashMap<String, Int>()
        ids.forEachIndexed { i, id ->
            if (i == ids.size - 1) r[id] = e.amountCents - allocated
            else { r[id] = base; allocated += base }
        }
        return r
    }

    // 每人净额：正=应收，负=应付
    fun netByMember(members: List<Member>, expenses: List<Expense>): Map<String, Int> {
        val paid = HashMap<String, Int>()
        val owed = HashMap<String, Int>()
        members.forEach { paid[it.id] = 0; owed[it.id] = 0 }
        expenses.forEach { e ->
            paid[e.payerId] = (paid[e.payerId] ?: 0) + e.amountCents
            shares(e).forEach { (id, v) -> owed[id] = (owed[id] ?: 0) + v }
        }
        return members.associate { it.id to ((paid[it.id] ?: 0) - (owed[it.id] ?: 0)) }
    }

    private data class Bal(val id: String, var amt: Int)

    // 贪心最小转账
    fun settle(net: Map<String, Int>): List<Transfer> {
        val debtors = net.filter { it.value < 0 }.map { Bal(it.key, -it.value) }
            .sortedByDescending { it.amt }.toMutableList()
        val creditors = net.filter { it.value > 0 }.map { Bal(it.key, it.value) }
            .sortedByDescending { it.amt }.toMutableList()
        val out = ArrayList<Transfer>()
        var i = 0; var j = 0
        while (i < debtors.size && j < creditors.size) {
            val pay = minOf(debtors[i].amt, creditors[j].amt)
            if (pay > 0) out.add(Transfer(debtors[i].id, creditors[j].id, pay))
            debtors[i].amt -= pay
            creditors[j].amt -= pay
            if (debtors[i].amt <= 0) i++
            if (creditors[j].amt <= 0) j++
        }
        return out
    }

    fun total(expenses: List<Expense>): Int = expenses.sumOf { it.amountCents }

    fun yuan(cents: Int): String = String.format("%.2f", cents / 100.0)
}
