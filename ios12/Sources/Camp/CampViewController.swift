import UIKit

// 营地：基于蓝牙 Mesh 的群聊（文字）。无移动网络/WiFi 也能互通。iOS 12 可用。
final class CampViewController: UIViewController, UITableViewDataSource, BleMeshDelegate, UITextFieldDelegate {

    private struct ChatMsg: Codable { let mid: String; let n: String; let t: String; let ts: Double }

    private let mesh = BleMesh()
    private let table = UITableView(frame: .zero, style: .plain)
    private let inputBar = UIView()
    private let field = UITextField()
    private let sendButton = UIButton(type: .system)
    private var inputBottom: NSLayoutConstraint!

    private var messages: [ChatMsg] = []
    private var seenMids = Set<String>()
    private var myName: String = ""
    private let myId = UUID().uuidString

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "营地"
        view.backgroundColor = .white
        loadNick()

        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "改昵称", style: .plain, target: self, action: #selector(renameNick))
        updatePeersTitle(0)

        // 表格
        table.dataSource = self
        table.separatorStyle = .none
        table.allowsSelection = false
        table.keyboardDismissMode = .interactive
        table.register(UITableViewCell.self, forCellReuseIdentifier: "c")
        table.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(table)

        // 输入栏
        inputBar.backgroundColor = UIColor(white: 0.97, alpha: 1)
        inputBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(inputBar)

        field.borderStyle = .roundedRect
        field.placeholder = "说点什么…（蓝牙范围内互通）"
        field.returnKeyType = .send
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(field)

        sendButton.setTitle("发送", for: .normal)
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(sendButton)

        let g = view.safeAreaLayoutGuide
        inputBottom = inputBar.bottomAnchor.constraint(equalTo: g.bottomAnchor)
        NSLayoutConstraint.activate([
            table.topAnchor.constraint(equalTo: g.topAnchor),
            table.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            table.bottomAnchor.constraint(equalTo: inputBar.topAnchor),

            inputBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            inputBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            inputBottom,
            inputBar.heightAnchor.constraint(equalToConstant: 52),

            field.leadingAnchor.constraint(equalTo: inputBar.leadingAnchor, constant: 10),
            field.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
            field.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),

            sendButton.trailingAnchor.constraint(equalTo: inputBar.trailingAnchor, constant: -12),
            sendButton.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
        ])

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChange(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)

        mesh.delegate = self
        mesh.start()
    }

    // MARK: - 昵称
    private func loadNick() {
        if let n = UserDefaults.standard.string(forKey: "trailmate.nick"), !n.isEmpty {
            myName = n
        } else {
            myName = "旅友" + String(format: "%03d", Int(arc4random_uniform(1000)))
            UserDefaults.standard.set(myName, forKey: "trailmate.nick")
        }
    }
    @objc private func renameNick() {
        let a = UIAlertController(title: "改昵称", message: nil, preferredStyle: .alert)
        a.addTextField { $0.text = self.myName }
        a.addAction(UIAlertAction(title: "取消", style: .cancel))
        a.addAction(UIAlertAction(title: "保存", style: .default) { [weak self] _ in
            guard let self = self, let n = a.textFields?.first?.text?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { return }
            self.myName = n
            UserDefaults.standard.set(n, forKey: "trailmate.nick")
        })
        present(a, animated: true)
    }

    private func updatePeersTitle(_ peers: Int) {
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "蓝牙邻居 \(peers)", style: .plain, target: nil, action: nil)
        navigationItem.rightBarButtonItem?.isEnabled = false
    }

    // MARK: - 发送
    @objc private func sendTapped() {
        guard let text = field.text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return }
        let msg = ChatMsg(mid: UUID().uuidString, n: myName, t: text, ts: Date().timeIntervalSince1970)
        appendIfNew(msg, mine: true)
        if let data = try? JSONEncoder().encode(msg) { mesh.send(data) }
        field.text = ""
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        sendTapped(); return true
    }

    private func appendIfNew(_ msg: ChatMsg, mine: Bool) {
        if seenMids.contains(msg.mid) { return }
        seenMids.insert(msg.mid)
        messages.append(msg)
        table.reloadData()
        if !messages.isEmpty {
            table.scrollToRow(at: IndexPath(row: messages.count - 1, section: 0), at: .bottom, animated: true)
        }
    }

    // MARK: - BleMeshDelegate
    func bleMesh(_ mesh: BleMesh, didReceive payload: Data) {
        guard let msg = try? JSONDecoder().decode(ChatMsg.self, from: payload) else { return }
        appendIfNew(msg, mine: false)
    }
    func bleMeshDidUpdatePeers(_ count: Int) {
        updatePeersTitle(count)
    }

    // MARK: - 键盘
    @objc private func keyboardChange(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let overlap = max(0, view.bounds.maxY - view.convert(end, from: nil).minY)
        let inset = max(0, overlap - view.safeAreaInsets.bottom)
        inputBottom.constant = -inset
        view.layoutIfNeeded()
        if !messages.isEmpty {
            table.scrollToRow(at: IndexPath(row: messages.count - 1, section: 0), at: .bottom, animated: false)
        }
    }

    // MARK: - UITableViewDataSource
    func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int {
        messages.isEmpty ? 1 : messages.count
    }
    func tableView(_ t: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let cell = t.dequeueReusableCell(withIdentifier: "c", for: ip)
        cell.textLabel?.numberOfLines = 0
        if messages.isEmpty {
            cell.textLabel?.text = "还没有消息。开启蓝牙、与附近同伴进入本页即可互聊（无需网络）。"
            cell.textLabel?.textColor = .gray
            cell.textLabel?.font = .systemFont(ofSize: 13)
        } else {
            let m = messages[ip.row]
            let mine = (m.n == myName)
            cell.textLabel?.textColor = .darkText
            cell.textLabel?.font = .systemFont(ofSize: 15)
            cell.textLabel?.text = mine ? "我：\(m.t)" : "\(m.n)：\(m.t)"
        }
        return cell
    }

    deinit { NotificationCenter.default.removeObserver(self) }
}
