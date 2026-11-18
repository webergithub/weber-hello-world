import UIKit
import WebKit

/// 全屏、横屏的网页外壳。
/// Info.plist 里的 TenUpServerURL 填了 https 网址就打开你的相册服务器；
/// 没填，或者服务器连不上，就打开随应用打包的那份网页（照片保存在这台 iPad 上）。
final class AlbumViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private var web: WKWebView!
    private var showingBundled = false
    private var downloadFile: URL?

    override var prefersStatusBarHidden: Bool { return true }
    override var prefersHomeIndicatorAutoHidden: Bool { return true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .landscape }

    private var serverURL: URL? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "TenUpServerURL") as? String,
              !text.isEmpty, let url = URL(string: text), url.scheme == "https" else { return nil }
        return url
    }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true                  // 摄像头小窗和音乐都在页面里播放
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "tenupPrint")     // 打印页的"打印或存成 PDF"
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.965, green: 0.929, blue: 0.890, alpha: 1)   // 底色 #f6ede3
        web.scrollView.backgroundColor = web.backgroundColor
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let url = serverURL {
            web.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 15))
        } else {
            loadBundled()
        }
    }

    private func loadBundled() {
        showingBundled = true
        guard let folder = Bundle.main.url(forResource: "web", withExtension: nil) else { return }
        web.loadFileURL(folder.appendingPathComponent("index.html"), allowingReadAccessTo: folder)
    }

    // 服务器连不上时退回到打包的网页
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !showingBundled { loadBundled() }
    }

    // 摄像头：只给相册自己的页面，且只给摄像头（不含麦克风）。系统仍会在第一次使用时询问一次。
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let isBundled = origin.protocol == "file"
        let isServer = serverURL != nil && origin.host == serverURL?.host
        decisionHandler((isBundled || isServer) && type == .camera ? .grant : .deny)
    }

    // 网页里的"确定 / 取消"提示（清空照片、退出登录时用到）
    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消 Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定 OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好 OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    // 打印与导出（print.html）：网页里的 window.print() 在应用里不起作用，改由 iOS 的打印面板来打印，
    // 面板里也可以存成 PDF 或分享。
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "tenupPrint" else { return }
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .photo
        info.jobName = (message.body as? String) ?? "十岁啦"
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printFormatter = web.viewPrintFormatter()
        controller.present(animated: true)
    }

    // 下载照片和视频（ZIP）：先存到临时文件夹，再弹出分享面板，可以"存储到文件"或用 AirDrop 发出去。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: url)
        downloadFile = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadFile else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: 80, width: 1, height: 1)
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = UIAlertController(title: nil, message: "下载没有成功，请再试一次\nThe download did not finish — please try again", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好 OK", style: .default))
        present(alert, animated: true)
    }
}
