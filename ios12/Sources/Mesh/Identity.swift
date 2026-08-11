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

    // 队伍码：跟车/营地按此分房间过滤。默认 "public"（公共队）。
    static var team: String {
        get { UserDefaults.standard.string(forKey: "trailmate.team") ?? "public" }
        set { UserDefaults.standard.set(newValue.isEmpty ? "public" : newValue, forKey: "trailmate.team") }
    }

    // 隐身（G-DR-3）：开启后不向同伴广播自己的位置
    static var ghost: Bool {
        get { UserDefaults.standard.bool(forKey: "trailmate.ghost") }
        set { UserDefaults.standard.set(newValue, forKey: "trailmate.ghost") }
    }

    // 网络中继（BR-1.1）：relayUrl 为空 = 只用蓝牙（默认，等同今日行为）。token 对应服务端 SIGNAL_TOKEN。
    static var relayUrl: String {
        get { UserDefaults.standard.string(forKey: "trailmate.relayUrl") ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: "trailmate.relayUrl") }
    }

    static var relayToken: String {
        get { UserDefaults.standard.string(forKey: "trailmate.relayToken") ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: "trailmate.relayToken") }
    }

    static func newTeamCode() -> String {
        let chars = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")   // 去掉易混字符
        var s = ""
        for _ in 0..<6 { s.append(chars[Int(arc4random_uniform(UInt32(chars.count)))]) }
        return s
    }
}
