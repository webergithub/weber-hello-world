import UIKit

// 记账：成员管理 + 记一笔（平均分摊）+ 各家账单 + 最优转账结算。纯 UIKit，iOS 12 可用。
final class LedgerViewController: UIViewController, UITableViewDataSource, UITableViewDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let table = UITableView(frame: .zero, style: .grouped)
    private let store = LedgerStore.shared
    private var pendingReceipt: String?   // 本次拍照小票文件名

    private enum Section: Int, CaseIterable { case members, expenses, settlement }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "记账"
        view.backgroundColor = .white

        table.frame = view.bounds
        table.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        table.dataSource = self
        table.delegate = self
        table.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        view.addSubview(table)

        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "＋成员", style: .plain, target: self, action: #selector(addMember))
        navigationItem.rightBarButtonItems = [
            UIBarButtonItem(title: "记一笔", style: .done, target: self, action: #selector(addExpense)),
            UIBarButtonItem(title: "📷小票", style: .plain, target: self, action: #selector(scanReceipt)),
        ]
    }

    // MARK: - 拍照小票
    @objc private func scanReceipt() {
        guard !store.members.isEmpty else { addExpense(); return }   // 复用"先加成员"提示
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            let a = UIAlertController(title: "无可用相机", message: "此设备/模拟器没有相机。", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "好", style: .default)); present(a, animated: true); return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        present(picker, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController,
                              didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage else { return }
        pendingReceipt = store.saveReceipt(image)
        let progress = UIAlertController(title: "识别中…", message: "正在读取小票金额", preferredStyle: .alert)
        present(progress, animated: true)
        ReceiptOCR.recognizeText(image) { [weak self] text in
            progress.dismiss(animated: true) {
                let cents = ReceiptOCR.guessAmountCents(text)
                self?.presentAddExpense(prefillCents: cents, note: cents == nil ? "未识别到金额，请手填（图片已存）" : "已识别金额，可修改")
            }
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        pendingReceipt = nil
    }

    private func reload() { table.reloadData() }

    // MARK: - 操作
    @objc private func addMember() {
        let a = UIAlertController(title: "添加成员", message: "同行的家庭/个人", preferredStyle: .alert)
        a.addTextField { $0.placeholder = "昵称"; $0.autocapitalizationType = .none }
        a.addAction(UIAlertAction(title: "取消", style: .cancel))
        a.addAction(UIAlertAction(title: "添加", style: .default) { [weak self] _ in
            guard let self = self, let name = a.textFields?.first?.text?.trimmingCharacters(in: .whitespaces), !name.isEmpty else { return }
            self.store.addMember(name: name)
            self.reload()
        })
        present(a, animated: true)
    }

    @objc private func addExpense() {
        guard !store.members.isEmpty else {
            let a = UIAlertController(title: "先添加成员", message: "记账前请先用左上「＋成员」登记同行者。", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "好", style: .default))
            present(a, animated: true); return
        }
        pendingReceipt = nil
        presentAddExpense(prefillCents: nil, note: nil)
    }

    private func presentAddExpense(prefillCents: Int?, note: String?) {
        var msg = "费用将在全体成员间平均分摊"
        if let note = note { msg += "\n" + note }
        let a = UIAlertController(title: "记一笔", message: msg, preferredStyle: .alert)
        a.addTextField { $0.placeholder = "项目（如 午餐 / 油费）" }
        a.addTextField {
            $0.placeholder = "金额（元）"; $0.keyboardType = .decimalPad
            if let c = prefillCents { $0.text = Ledger.yuan(c) }
        }
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.pendingReceipt = nil })
        a.addAction(UIAlertAction(title: "下一步：选付款人", style: .default) { [weak self] _ in
            guard let self = self else { return }
            let title = a.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            let amtText = a.textFields?.last?.text?.replacingOccurrences(of: ",", with: ".") ?? ""
            let cents = Int((Double(amtText) ?? 0) * 100 + 0.5)
            guard cents > 0 else { return }
            self.pickPayer(title: title.isEmpty ? "消费" : title, cents: cents)
        })
        present(a, animated: true)
    }

    private func pickPayer(title: String, cents: Int) {
        let sheet = UIAlertController(title: "谁付的款？", message: "\(title) · ¥\(Ledger.yuan(cents))", preferredStyle: .actionSheet)
        for m in store.members {
            sheet.addAction(UIAlertAction(title: m.name, style: .default) { [weak self] _ in
                guard let self = self else { return }
                self.store.addExpense(title: title, payerId: m.id, amountCents: cents,
                                      participantIds: self.store.members.map { $0.id },
                                      receiptPath: self.pendingReceipt)
                self.pendingReceipt = nil
                self.reload()
            })
        }
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.pendingReceipt = nil })
        if let pop = sheet.popoverPresentationController {
            pop.barButtonItem = navigationItem.rightBarButtonItems?.first
        }
        present(sheet, animated: true)
    }

    // MARK: - UITableViewDataSource
    func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    func tableView(_ t: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch Section(rawValue: section)! {
        case .members: return "成员（\(store.members.count)）"
        case .expenses: return "消费明细 · 合计 ¥\(Ledger.yuan(Ledger.totalCents(store.expenses)))"
        case .settlement: return "结算"
        }
    }

    func tableView(_ t: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch Section(rawValue: section)! {
        case .members: return max(store.members.count, 1)
        case .expenses: return max(store.expenses.count, 1)
        case .settlement:
            let transfers = Ledger.settle(Ledger.balances(members: store.members, expenses: store.expenses))
            return max(transfers.count, 1)
        }
    }

    func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let cell = t.dequeueReusableCell(withIdentifier: "cell", for: ip)
        cell.accessoryType = .none
        cell.selectionStyle = .none
        cell.textLabel?.textColor = .darkText
        cell.detailTextLabel?.text = nil

        switch Section(rawValue: ip.section)! {
        case .members:
            if store.members.isEmpty {
                cell.textLabel?.text = "还没有成员，点左上「＋成员」添加"
                cell.textLabel?.textColor = .gray
            } else {
                cell.textLabel?.text = store.members[ip.row].name
            }
        case .expenses:
            if store.expenses.isEmpty {
                cell.textLabel?.text = "还没有记账，点右上「记一笔」"
                cell.textLabel?.textColor = .gray
            } else {
                let e = store.expenses[ip.row]
                cell.textLabel?.numberOfLines = 0
                let payer = store.name(of: e.payerId)
                let receipt = e.receiptPath != nil ? "📷 " : ""
                cell.textLabel?.text = "\(receipt)\(e.title)  ¥\(Ledger.yuan(e.amountCents))\n\(payer) 垫付 · \(e.participantIds.count) 人分摊"
            }
        case .settlement:
            let transfers = Ledger.settle(Ledger.balances(members: store.members, expenses: store.expenses))
            if transfers.isEmpty {
                cell.textLabel?.text = store.expenses.isEmpty ? "记账后这里显示结算方案" : "账目已平，无需转账 ✓"
                cell.textLabel?.textColor = .gray
            } else {
                let tr = transfers[ip.row]
                cell.textLabel?.text = "\(store.name(of: tr.fromId))  →  \(store.name(of: tr.toId))   ¥\(Ledger.yuan(tr.amountCents))"
            }
        }
        return cell
    }

    // 左滑删除成员/消费
    func tableView(_ t: UITableView, canEditRowAt ip: IndexPath) -> Bool {
        switch Section(rawValue: ip.section)! {
        case .members: return !store.members.isEmpty
        case .expenses: return !store.expenses.isEmpty
        case .settlement: return false
        }
    }

    func tableView(_ t: UITableView, commit editingStyle: UITableViewCell.EditingStyle, forRowAt ip: IndexPath) {
        guard editingStyle == .delete else { return }
        switch Section(rawValue: ip.section)! {
        case .members: store.removeMember(id: store.members[ip.row].id)
        case .expenses: store.removeExpense(id: store.expenses[ip.row].id)
        case .settlement: break
        }
        reload()
    }
}
