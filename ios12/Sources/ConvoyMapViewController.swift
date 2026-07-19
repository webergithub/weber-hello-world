import UIKit
import MapKit
import CoreLocation

// 跟车：MapKit 地图（道路/卫星）+ CoreLocation 定位 + 通过蓝牙 Mesh 与同行者共享位置（离线可用）。
// 全部为 iOS 12 可用 API。

private final class PeerAnnotation: NSObject, MKAnnotation {
    let id: String
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var title: String?
    var lastSeen = Date()   // 在线态（G-DR-2）
    init(id: String, coordinate: CLLocationCoordinate2D, title: String) {
        self.id = id; self.coordinate = coordinate; self.title = title
    }
}

private struct Loc: Codable { let id: String; let n: String; let lat: Double; let lng: Double; let ts: Double }

final class ConvoyMapViewController: UIViewController, CLLocationManagerDelegate {
    private let map = MKMapView()
    private let manager = CLLocationManager()
    private let modeControl = UISegmentedControl(items: ["道路", "卫星"])
    private let healthBanner = UILabel()
    private var centeredOnce = false
    private var peers: [String: PeerAnnotation] = [:]
    private var lastBroadcast: TimeInterval = 0
    private var ageTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "跟车"
        view.backgroundColor = .white

        map.frame = view.bounds
        map.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        map.showsUserLocation = true
        map.showsCompass = true
        view.addSubview(map)

        modeControl.selectedSegmentIndex = 0
        modeControl.addTarget(self, action: #selector(modeChanged), for: .valueChanged)
        navigationItem.titleView = modeControl
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "定位", style: .plain, target: self, action: #selector(recenter))

        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()

        // 位置共享链路健康横幅（G-DR-1）：蓝牙关/无邻居时如实告知
        healthBanner.font = .systemFont(ofSize: 13)
        healthBanner.textColor = .white
        healthBanner.backgroundColor = UIColor(red: 0.7, green: 0.45, blue: 0.03, alpha: 0.92)
        healthBanner.textAlignment = .center
        healthBanner.numberOfLines = 0
        healthBanner.isHidden = true
        healthBanner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(healthBanner)
        NSLayoutConstraint.activate([
            healthBanner.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            healthBanner.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            healthBanner.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            healthBanner.heightAnchor.constraint(greaterThanOrEqualToConstant: 26),
        ])

        // 共享 Mesh：启动 + 订阅同行者位置
        MeshBus.shared.start()
        MeshBus.shared.subscribe(MeshBus.kindLoc) { [weak self] data in
            guard let self = self, let loc = try? JSONDecoder().decode(Loc.self, from: data) else { return }
            self.updatePeer(loc)
        }
        MeshBus.shared.onState("convoy") { [weak self] _ in self?.renderHealth() }
        MeshBus.shared.onPeers("convoy") { [weak self] _ in self?.renderHealth() }

        // 在线态（G-DR-2）：15s 未更新变淡，60s 移除
        ageTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.agePeers()
        }
    }

    deinit { ageTimer?.invalidate() }

    private func agePeers() {
        var gone: [String] = []
        for (id, ann) in peers {
            let age = -ann.lastSeen.timeIntervalSinceNow
            if age > 60 {
                gone.append(id)
            } else {
                map.view(for: ann)?.alpha = age > 15 ? 0.45 : 1.0
            }
        }
        for id in gone {
            if let ann = peers.removeValue(forKey: id) { map.removeAnnotation(ann) }
        }
    }

    private func renderHealth() {
        if !MeshBus.shared.btAvailable {
            healthBanner.isHidden = false
            healthBanner.text = "⚠️ 蓝牙已关闭，位置无法共享给同伴"
        } else if MeshBus.shared.peerCount == 0 {
            healthBanner.isHidden = false
            healthBanner.text = "附近无蓝牙邻居，同伴暂看不到你的位置"
        } else {
            healthBanner.isHidden = true
        }
    }

    @objc private func modeChanged() {
        map.mapType = modeControl.selectedSegmentIndex == 0 ? .standard : .satellite
    }

    @objc private func recenter() {
        if let loc = manager.location {
            map.setRegion(MKCoordinateRegion(center: loc.coordinate, latitudinalMeters: 800, longitudinalMeters: 800), animated: true)
        } else {
            manager.startUpdatingLocation()
        }
    }

    private func updatePeer(_ loc: Loc) {
        let coord = CLLocationCoordinate2D(latitude: loc.lat, longitude: loc.lng)
        if let ann = peers[loc.id] {
            ann.coordinate = coord
            ann.title = loc.n
            ann.lastSeen = Date()
            map.view(for: ann)?.alpha = 1.0
        } else {
            let ann = PeerAnnotation(id: loc.id, coordinate: coord, title: loc.n)
            peers[loc.id] = ann
            map.addAnnotation(ann)
        }
    }

    // MARK: - CLLocationManagerDelegate
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        if !centeredOnce {
            centeredOnce = true
            map.setRegion(MKCoordinateRegion(center: loc.coordinate, latitudinalMeters: 800, longitudinalMeters: 800), animated: true)
        }
        // 节流广播自身位置（每 3 秒），供同行者在地图上看到我
        let now = Date().timeIntervalSince1970
        if now - lastBroadcast >= 3 {
            lastBroadcast = now
            let mine = Loc(id: Identity.deviceId, n: Identity.nick,
                           lat: loc.coordinate.latitude, lng: loc.coordinate.longitude, ts: now)
            if let data = try? JSONEncoder().encode(mine) { MeshBus.shared.send(MeshBus.kindLoc, data) }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { }
}
