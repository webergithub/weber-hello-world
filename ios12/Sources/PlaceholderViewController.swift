import UIKit

// 占位页：后续里程碑逐个替换为记账/营地/变声的真实实现。
final class PlaceholderViewController: UIViewController {
    private let name: String
    private let note: String

    init(name: String, note: String) {
        self.name = name
        self.note = note
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = name
        view.backgroundColor = .white

        let icon = UILabel()
        icon.text = "🚧"
        icon.font = .systemFont(ofSize: 44)
        icon.textAlignment = .center

        let label = UILabel()
        label.text = note
        label.textColor = .gray
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 15)

        let stack = UIStackView(arrangedSubviews: [icon, label])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
        ])
    }
}
