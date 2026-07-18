import UIKit
import MapKit
import CoreLocation

// 跟车：MapKit 地图（道路/卫星）+ CoreLocation 定位 + 通过蓝牙 Mesh 与同行者共享位置（离线可用）。
// 全部为 iOS 12 可用 API。

private final class PeerAnnotation: NSObject, MKAnnotation {
    let id: String
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var title: String?
    init(id: String, coordinate: CLLocationCoordinate2D, title: String) {
        self.id = id; self.coordinate = coordinate; self.title = title
    }
}

private struct Loc: Codable { let id: String; let n: String; let lat: Double; let lng: Double; let ts: Double }

final class ConvoyMapViewController: UIViewController, CLLocationManagerDelegate {
    private let map = MKMapView()
    private let manager = CLLocationManager()
    private let modeControl = UISegmentedControl(items: ["道路", "卫星"])
    private var centeredOnce = false
    private var peers: [String: PeerAnnotation] = [:]
    private var lastBroadcast: TimeInterval = 0

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

        // 共享 Mesh：启动 + 订阅同行者位置
        MeshBus.shared.start()
        MeshBus.shared.subscribe(MeshBus.kindLoc) { [weak self] data in
            guard let self = self, let loc = try? JSONDecoder().decode(Loc.self, from: data) else { return }
            self.updatePeer(loc)
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
