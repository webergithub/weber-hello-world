package cc.trailmate.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

// SharedPreferences + JSON 持久化（无第三方依赖）
class LedgerStore(ctx: Context) {
    private val sp = ctx.getSharedPreferences("trailmate", Context.MODE_PRIVATE)

    val members = ArrayList<Member>()
    val expenses = ArrayList<Expense>()

    init { load() }

    fun addMember(name: String) {
        members.add(Member(UUID.randomUUID().toString(), name))
        save()
    }

    fun removeMember(id: String) {
        members.removeAll { it.id == id }
        expenses.removeAll { it.payerId == id }
        val cleaned = expenses.map { it.copy(participantIds = it.participantIds.filter { p -> p != id }) }
            .filter { it.participantIds.isNotEmpty() }
        expenses.clear(); expenses.addAll(cleaned)
        save()
    }

    fun addExpense(title: String, payerId: String, amountCents: Int, participantIds: List<String>) {
        expenses.add(0, Expense(UUID.randomUUID().toString(), title, payerId, amountCents, participantIds))
        save()
    }

    fun removeExpense(id: String) {
        expenses.removeAll { it.id == id }
        save()
    }

    fun name(id: String): String = members.firstOrNull { it.id == id }?.name ?: "?"

    private fun save() {
        val root = JSONObject()
        val ms = JSONArray()
        members.forEach { ms.put(JSONObject().put("id", it.id).put("name", it.name)) }
        val es = JSONArray()
        expenses.forEach {
            es.put(
                JSONObject()
                    .put("id", it.id).put("title", it.title).put("payerId", it.payerId)
                    .put("amountCents", it.amountCents)
                    .put("participantIds", JSONArray(it.participantIds))
            )
        }
        root.put("members", ms).put("expenses", es)
        sp.edit().putString("ledger", root.toString()).apply()
    }

    private fun load() {
        val s = sp.getString("ledger", null) ?: return
        try {
            val root = JSONObject(s)
            val ms = root.getJSONArray("members")
            for (i in 0 until ms.length()) {
                val o = ms.getJSONObject(i)
                members.add(Member(o.getString("id"), o.getString("name")))
            }
            val es = root.getJSONArray("expenses")
            for (i in 0 until es.length()) {
                val o = es.getJSONObject(i)
                val pids = ArrayList<String>()
                val arr = o.getJSONArray("participantIds")
                for (k in 0 until arr.length()) pids.add(arr.getString(k))
                expenses.add(
                    Expense(o.getString("id"), o.getString("title"), o.getString("payerId"),
                        o.getInt("amountCents"), pids)
                )
            }
        } catch (_: Exception) { }
    }
}
