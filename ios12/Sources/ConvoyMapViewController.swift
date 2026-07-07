import UIKit
import MapKit
import CoreLocation

// 跟车：MapKit 地图（道路/卫星切换）+ CoreLocation 实时定位。全部为 iOS 12 可用 API。
final class ConvoyMapViewController: UIViewController, CLLocationManagerDelegate {
    private let map = MKMapView()
    private let manager = CLLocationManager()
    private let modeControl = UISegmentedControl(items: ["道路", "卫星"])
    private var centeredOnce = false

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

        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "定位", style: .plain, target: self, action: #selector(recenter))

        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    @objc private func modeChanged() {
        map.mapType = modeControl.selectedSegmentIndex == 0 ? .standard : .satellite
    }

    @objc private func recenter() {
        if let loc = manager.location {
            let region = MKCoordinateRegion(center: loc.coordinate,
                                            latitudinalMeters: 800, longitudinalMeters: 800)
            map.setRegion(region, animated: true)
        } else {
            manager.startUpdatingLocation()
        }
    }

    // MARK: - CLLocationManagerDelegate
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        if !centeredOnce {
            centeredOnce = true
            let region = MKCoordinateRegion(center: loc.coordinate,
                                            latitudinalMeters: 800, longitudinalMeters: 800)
            map.setRegion(region, animated: true)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // 定位失败静默处理（真机首启需用户在系统弹窗中授权）
    }
}
