import UIKit

// 出行综合 App 的底部 Tab 骨架。当前里程碑：跟车（地图+定位）已实现，其余为占位。
final class RootTabBarController: UITabBarController {
    override func viewDidLoad() {
        super.viewDidLoad()

        let brand = UIColor(red: 0.08, green: 0.46, blue: 0.43, alpha: 1)
        tabBar.tintColor = brand

        let convoy = wrap(ConvoyMapViewController(), title: "跟车")
        let ledger = wrap(PlaceholderViewController(name: "记账", note: "AA 记账分摊 · 拍照小票\n（即将上线）"), title: "记账")
        let camp = wrap(PlaceholderViewController(name: "营地", note: "蓝牙自组网 · 无信号互通\n（即将上线）"), title: "营地")
        let voice = wrap(PlaceholderViewController(name: "变声", note: "趣味变声\n（即将上线）"), title: "变声")

        viewControllers = [convoy, ledger, camp, voice]
    }

    private func wrap(_ vc: UIViewController, title: String) -> UINavigationController {
        let nav = UINavigationController(rootViewController: vc)
        nav.tabBarItem = UITabBarItem(title: title, image: nil, tag: 0)
        return nav
    }
}
