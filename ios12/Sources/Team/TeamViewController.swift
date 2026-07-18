import UIKit

// 队伍：显示/新建队伍码 + 二维码（供他人扫码入队）+ 扫码入队。
// 加入同一队伍后，跟车位置与营地聊天只在本队内互通（MeshBus 按 team 过滤）。
final class TeamViewController: UIViewController {
    private let codeLabel = UILabel()
    private let qrView = UIImageView()
    private let hint = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "队伍"
        view.backgroundColor = .white
        buildUI()
        refresh()
    }

    private func buildUI() {
        let title = UILabel()
        title.text = "我的队伍码"
        title.font = .systemFont(ofSize: 15)
        title.textColor = .gray
        title.textAlignment = .center

        codeLabel.font = .monospacedDigitSystemFont(ofSize: 40, weight: .bold)
        codeLabel.textColor = UIColor(red: 0.06, green: 0.46, blue: 0.43, alpha: 1)
        codeLabel.textAlignment = .center

        qrView.contentMode = .scaleAspectFit
        qrView.heightAnchor.constraint(equalToConstant: 200).isActive = true

        hint.font = .systemFont(ofSize: 13)
        hint.textColor = .gray
        hint.numberOfLines = 0
        hint.textAlignment = .center

        let newBtn = makeButton("🔄 新建队伍", primary: false)
        newBtn.addTarget(self, action: #selector(newTeam), for: .touchUpInside)
        let scanBtn = makeButton("📷 扫码入队", primary: true)
        scanBtn.addTarget(self, action: #selector(scan), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, codeLabel, qrView, hint, scanBtn, newBtn])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: g.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }

    private func makeButton(_ t: String, primary: Bool) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(t, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        b.backgroundColor = primary ? UIColor(red: 0.06, green: 0.46, blue: 0.43, alpha: 1) : UIColor(white: 0.95, alpha: 1)
        b.setTitleColor(primary ? .white : .darkText, for: .normal)
        b.layer.cornerRadius = 10
        b.heightAnchor.constraint(equalToConstant: 50).isActive = true
        return b
    }

    private func refresh() {
        let team = Identity.team
        if team == "public" {
            codeLabel.text = "公共队"
            hint.text = "当前在「公共队」：附近所有人可互见。\n新建或扫码加入私有队伍后，只与本队同伴互通位置与消息。"
            qrView.image = QRCode.image(for: QRCode.prefix + "public", size: 200)
        } else {
            codeLabel.text = team
            hint.text = "让同伴打开本页「扫码入队」扫描上方二维码，\n即可与你进入同一队伍（跟车位置 / 营地聊天仅本队互通）。"
            qrView.image = QRCode.image(for: QRCode.prefix + team, size: 200)
        }
    }

    @objc private func newTeam() {
        Identity.team = Identity.newTeamCode()
        refresh()
    }

    @objc private func scan() {
        let scanner = QRScannerViewController()
        scanner.onResult = { [weak self] text in
            if let code = QRCode.parseTeam(text) {
                Identity.team = code
                self?.dismiss(animated: true) { self?.refresh() }
            } else {
                self?.dismiss(animated: true)
            }
        }
        let nav = UINavigationController(rootViewController: scanner)
        present(nav, animated: true)
    }
}
