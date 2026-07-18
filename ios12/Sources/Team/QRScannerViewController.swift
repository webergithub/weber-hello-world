import UIKit
import AVFoundation

// 扫码入队（AVCaptureMetadataOutput，iOS 12 可用）。识别到二维码回调文本。
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onResult: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "扫码入队"
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))

        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if granted { self.configure() } else { self.showNoCamera() }
            }
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { showNoCamera(); return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { showNoCamera(); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.frame = view.bounds
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer

        let hint = UILabel()
        hint.text = "将同伴出示的队伍二维码对准取景框"
        hint.textColor = .white
        hint.textAlignment = .center
        hint.frame = CGRect(x: 0, y: view.bounds.height - 120, width: view.bounds.width, height: 24)
        hint.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        view.addSubview(hint)

        session.startRunning()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    private func showNoCamera() {
        let l = UILabel()
        l.text = "需要摄像头权限才能扫码\n（设置 → 隐私 → 相机）"
        l.textColor = .white
        l.numberOfLines = 0
        l.textAlignment = .center
        l.frame = view.bounds
        l.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(l)
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !handled,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr, let text = obj.stringValue else { return }
        handled = true
        session.stopRunning()
        onResult?(text)
    }

    @objc private func cancel() { dismiss(animated: true) }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }
}
