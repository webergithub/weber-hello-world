import UIKit

// 纯代码启动，不用 SceneDelegate（iOS 13+ 才有；这里兼容 iOS 12）。
@UIApplicationMain
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = RootTabBarController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
