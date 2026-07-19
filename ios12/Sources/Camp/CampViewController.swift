import UIKit
import AVFoundation

// 营地：基于共享蓝牙 Mesh 的群聊。无移动网络/WiFi 也能互通。iOS 12 可用。
// 文字 {mid,n,t,ts}（kindChat）；短语音 [u16 jsonLen][{mid,n,d,ts}][m4a]（kindVoice，≤10s，G-CM-1）。
final class CampViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate {

    private struct ChatMsg: Codable { let mid: String; let n: String; let t: String; let ts: Double }
    private struct VoiceMeta: Codable { let mid: String; let n: String; let d: Double; let ts: Double }

    private let table = UITableView(frame: .zero, style: .plain)
    private let inputBar = UIView()
    private let field = UITextField()
    private let sendButton = UIButton(type: .system)
    private let micButton = UIButton(type: .system)
    private var inputBottom: NSLayoutConstraint!

    private var messages: [ChatMsg] = []
    private var seenMids = Set<String>()
    private var myName: String = Identity.nick

    // 短语音（G-CM-1）
    private var voiceFiles: [String: URL] = [:]   // mid -> 本地 m4a
    private var recorder: AVAudioRecorder?
    private var recordStart = Date()
    private var player: AVAudioPlayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "营地"
        view.backgroundColor = .white

        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "改昵称", style: .plain, target: self, action: #selector(renameNick))
        updatePeersTitle(MeshBus.shared.peerCount)

        table.dataSource = self
        table.delegate = self
        table.separatorStyle = .none
        table.allowsSelection = true   // 语音行点按播放
        table.keyboardDismissMode = .interactive
        table.register(UITableViewCell.self, forCellReuseIdentifier: "c")
        table.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(table)

        inputBar.backgroundColor = UIColor(white: 0.97, alpha: 1)
        inputBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(inputBar)

        field.borderStyle = .roundedRect
        field.placeholder = "说点什么…（蓝牙范围内互通）"
        field.returnKeyType = .send
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(field)

        micButton.setTitle("🎤", for: .normal)
        micButton.titleLabel?.font = .systemFont(ofSize: 22)
        micButton.addTarget(self, action: #selector(micDown), for: .touchDown)
        micButton.addTarget(self, action: #selector(micUp), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        micButton.translatesAutoresizingMaskIntoConstraints = false
        inputBar.addSubview(micButton)

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
            field.trailingAnchor.constraint(equalTo: micButton.leadingAnchor, constant: -6),

            micButton.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -6),
            micButton.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),

            sendButton.trailingAnchor.constraint(equalTo: inputBar.trailingAnchor, constant: -12),
            sendButton.centerYAnchor.constraint(equalTo: inputBar.centerYAnchor),
        ])

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChange(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)

        // 共享 Mesh：启动 + 订阅聊天 + 邻居数
        MeshBus.shared.start()
        MeshBus.shared.subscribe(MeshBus.kindChat) { [weak self] data in
            guard let self = self, let msg = try? JSONDecoder().decode(ChatMsg.self, from: data) else { return }
            self.appendIfNew(msg)
        }
        MeshBus.shared.subscribe(MeshBus.kindVoice) { [weak self] data in self?.onVoice(data) }
        MeshBus.shared.onPeers { [weak self] count in self?.updatePeersTitle(count) }
        // 链路健康（PR-P1-1）：蓝牙关闭时立刻在标题栏亮红字，绝不"界面照常"
        MeshBus.shared.onState { [weak self] available in
            guard let self = self else { return }
            if available {
                self.updatePeersTitle(MeshBus.shared.peerCount)
            } else {
                self.navigationItem.rightBarButtonItem =
                    UIBarButtonItem(title: "⚠️ 蓝牙已关闭", style: .plain, target: nil, action: nil)
                self.navigationItem.rightBarButtonItem?.tintColor = .red
                self.navigationItem.rightBarButtonItem?.isEnabled = false
            }
        }
    }

    // MARK: - 昵称
    @objc private func renameNick() {
        let a = UIAlertController(title: "改昵称", message: nil, preferredStyle: .alert)
        a.addTextField { $0.text = self.myName }
        a.addAction(UIAlertAction(title: "取消", style: .cancel))
        a.addAction(UIAlertAction(title: "保存", style: .default) { [weak self] _ in
            guard let self = self, let n = a.textFields?.first?.text?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { return }
            self.myName = n
            Identity.nick = n
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
        appendIfNew(msg)
        if let data = try? JSONEncoder().encode(msg) { MeshBus.shared.send(MeshBus.kindChat, data) }
        field.text = ""
        // 送达可见性（PR-P1-2 部分）：无邻居/蓝牙关闭时如实告知
        if !MeshBus.shared.btAvailable {
            appendIfNew(ChatMsg(mid: UUID().uuidString, n: "系统",
                                t: "⚠️ 蓝牙已关闭，这条消息发不出去", ts: Date().timeIntervalSince1970))
        } else if MeshBus.shared.peerCount == 0 {
            appendIfNew(ChatMsg(mid: UUID().uuidString, n: "系统",
                                t: "⚠️ 附近无蓝牙邻居，这条消息此刻无人能收到", ts: Date().timeIntervalSince1970))
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool { sendTapped(); return true }

    // MARK: - 短语音（G-CM-1）：按住 🎤 录（≤10s，AAC 16kHz 24kbps），松开加密广播
    @objc private func micDown() {
        let session = AVAudioSession.sharedInstance()
        session.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self = self, granted else { return }
                try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try? session.setActive(true)
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice_out.m4a")
                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 16000,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderBitRateKey: 24000,
                ]
                guard let r = try? AVAudioRecorder(url: url, settings: settings) else { return }
                r.record(forDuration: 10)   // 上限 10s ≈ 30KB，BLE 泛洪 2~3 秒可达
                self.recorder = r
                self.recordStart = Date()
                self.micButton.setTitle("⏺", for: .normal)
            }
        }
    }

    @objc private func micUp() {
        micButton.setTitle("🎤", for: .normal)
        guard let r = recorder else { return }
        recorder = nil
        r.stop()
        let dur = Date().timeIntervalSince(recordStart)
        guard dur >= 0.4, let m4a = try? Data(contentsOf: r.url), m4a.count <= 40_000 else {
            appendIfNew(ChatMsg(mid: UUID().uuidString, n: "系统",
                                t: dur < 0.4 ? "语音太短，未发送" : "语音过长，未发送",
                                ts: Date().timeIntervalSince1970))
            return
        }
        let mid = UUID().uuidString
        let d = (dur * 10).rounded() / 10
        let meta = VoiceMeta(mid: mid, n: myName, d: d, ts: Date().timeIntervalSince1970)
        guard let json = try? JSONEncoder().encode(meta) else { return }
        var payload = Data([UInt8((json.count >> 8) & 0xFF), UInt8(json.count & 0xFF)])
        payload.append(json)
        payload.append(m4a)
        let mine = FileManager.default.temporaryDirectory.appendingPathComponent("voice_\(mid).m4a")
        try? m4a.write(to: mine)
        voiceFiles[mid] = mine
        appendIfNew(ChatMsg(mid: mid, n: myName, t: "🎤 语音 \(d)s（点按播放）", ts: meta.ts))
        MeshBus.shared.send(MeshBus.kindVoice, payload)
        if MeshBus.shared.peerCount == 0 {
            appendIfNew(ChatMsg(mid: UUID().uuidString, n: "系统",
                                t: "⚠️ 附近无蓝牙邻居，这条语音此刻无人能收到", ts: Date().timeIntervalSince1970))
        }
    }

    private func onVoice(_ body: Data) {
        guard body.count > 3 else { return }
        let jlen = (Int(body[0]) << 8) | Int(body[1])
        guard body.count > 2 + jlen,
              let meta = try? JSONDecoder().decode(VoiceMeta.self, from: body.subdata(in: 2..<(2 + jlen)))
        else { return }
        let m4a = body.subdata(in: (2 + jlen)..<body.count)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice_\(meta.mid).m4a")
        try? m4a.write(to: url)
        voiceFiles[meta.mid] = url
        appendIfNew(ChatMsg(mid: meta.mid, n: meta.n, t: "🎤 语音 \(meta.d)s（点按播放）", ts: meta.ts))
    }

    func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: true)
        guard !messages.isEmpty, ip.row < messages.count,
              let url = voiceFiles[messages[ip.row].mid] else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        player = try? AVAudioPlayer(contentsOf: url)
        player?.play()
    }

    private func appendIfNew(_ msg: ChatMsg) {
        if seenMids.contains(msg.mid) { return }
        seenMids.insert(msg.mid)
        messages.append(msg)
        table.reloadData()
        if !messages.isEmpty {
            table.scrollToRow(at: IndexPath(row: messages.count - 1, section: 0), at: .bottom, animated: true)
        }
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
    func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int { messages.isEmpty ? 1 : messages.count }
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
