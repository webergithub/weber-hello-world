import UIKit

// 记账领域模型 + AA 结算算法（纯逻辑，iOS 12 可用）。金额一律用「分」整数，杜绝浮点误差。

struct Member: Codable, Equatable {
    let id: String
    var name: String
}

struct Expense: Codable {
    let id: String
    var title: String
    var payerId: String
    var amountCents: Int
    var participantIds: [String]   // 参与分摊的成员（快照）
    var receiptPath: String?       // 小票照片文件名（可选）
}

struct Transfer {
    let fromId: String
    let toId: String
    let amountCents: Int
}

struct MemberBalance {
    let memberId: String
    let paidCents: Int
    let owedCents: Int
    var netCents: Int { paidCents - owedCents }   // 正=应收，负=应付
}

enum Ledger {
    // 单笔消费中每个参与者应承担（平均分，余数给最后一人）
    static func shares(of e: Expense) -> [String: Int] {
        var result: [String: Int] = [:]
        let ids = e.participantIds
        guard !ids.isEmpty else { return result }
        let base = e.amountCents / ids.count
        var allocated = 0
        for (i, id) in ids.enumerated() {
            if i == ids.count - 1 {
                result[id] = e.amountCents - allocated
            } else {
                result[id] = base
                allocated += base
            }
        }
        return result
    }

    static func balances(members: [Member], expenses: [Expense]) -> [MemberBalance] {
        var paid: [String: Int] = [:]
        var owed: [String: Int] = [:]
        for m in members { paid[m.id] = 0; owed[m.id] = 0 }
        for e in expenses {
            paid[e.payerId, default: 0] += e.amountCents
            for (id, v) in shares(of: e) { owed[id, default: 0] += v }
        }
        return members.map {
            MemberBalance(memberId: $0.id, paidCents: paid[$0.id] ?? 0, owedCents: owed[$0.id] ?? 0)
        }
    }

    // 贪心最小转账：最大债务人还给最大债权人，笔数 <= n-1
    static func settle(_ balances: [MemberBalance]) -> [Transfer] {
        var debtors = balances.filter { $0.netCents < 0 }
            .map { (id: $0.memberId, amt: -$0.netCents) }
            .sorted { $0.amt > $1.amt }
        var creditors = balances.filter { $0.netCents > 0 }
            .map { (id: $0.memberId, amt: $0.netCents) }
            .sorted { $0.amt > $1.amt }

        var transfers: [Transfer] = []
        var i = 0, j = 0
        while i < debtors.count && j < creditors.count {
            let pay = min(debtors[i].amt, creditors[j].amt)
            if pay > 0 {
                transfers.append(Transfer(fromId: debtors[i].id, toId: creditors[j].id, amountCents: pay))
            }
            debtors[i].amt -= pay
            creditors[j].amt -= pay
            if debtors[i].amt <= 0 { i += 1 }
            if creditors[j].amt <= 0 { j += 1 }
        }
        return transfers
    }

    static func totalCents(_ expenses: [Expense]) -> Int {
        expenses.reduce(0) { $0 + $1.amountCents }
    }

    static func yuan(_ cents: Int) -> String {
        let v = Double(cents) / 100.0
        return String(format: "%.2f", v)
    }
}

// UserDefaults 持久化
final class LedgerStore {
    static let shared = LedgerStore()
    private let key = "trailmate.ledger.v1"

    private(set) var members: [Member] = []
    private(set) var expenses: [Expense] = []

    private init() { load() }

    func addMember(name: String) {
        members.append(Member(id: UUID().uuidString, name: name))
        save()
    }

    func removeMember(id: String) {
        members.removeAll { $0.id == id }
        expenses.removeAll { $0.payerId == id }
        for idx in expenses.indices {
            expenses[idx].participantIds.removeAll { $0 == id }
        }
        expenses.removeAll { $0.participantIds.isEmpty }
        save()
    }

    func addExpense(title: String, payerId: String, amountCents: Int, participantIds: [String], receiptPath: String? = nil) {
        expenses.insert(Expense(id: UUID().uuidString, title: title, payerId: payerId,
                                amountCents: amountCents, participantIds: participantIds,
                                receiptPath: receiptPath), at: 0)
        save()
    }

    // 保存小票图片到 Documents，返回文件名
    func saveReceipt(_ image: UIImage) -> String? {
        guard let data = image.jpegData(compressionQuality: 0.6) else { return nil }
        let name = "receipt_\(UUID().uuidString).jpg"
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
        do { try data.write(to: url); return name } catch { return nil }
    }

    func removeExpense(id: String) {
        expenses.removeAll { $0.id == id }
        save()
    }

    func name(of id: String) -> String {
        members.first { $0.id == id }?.name ?? "?"
    }

    private func save() {
        let payload = Persisted(members: members, expenses: expenses)
        if let data = try? JSONEncoder().encode(payload) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: key),
              let p = try? JSONDecoder().decode(Persisted.self, from: data) else { return }
        members = p.members
        expenses = p.expenses
    }

    private struct Persisted: Codable {
        var members: [Member]
        var expenses: [Expense]
    }
}
