import Foundation

// 本机身份：稳定设备 ID（用于跟车位置去重/更新）+ 昵称（营地/跟车共用）。
enum Identity {
    static var deviceId: String {
        if let s = UserDefaults.standard.string(forKey: "trailmate.deviceId") { return s }
        let s = UUID().uuidString
        UserDefaults.standard.set(s, forKey: "trailmate.deviceId")
        return s
    }

    static var nick: String {
        get {
            if let n = UserDefaults.standard.string(forKey: "trailmate.nick"), !n.isEmpty { return n }
            let n = "旅友" + String(format: "%03d", Int(arc4random_uniform(1000)))
            UserDefaults.standard.set(n, forKey: "trailmate.nick")
            return n
        }
        set { UserDefaults.standard.set(newValue, forKey: "trailmate.nick") }
    }
}
