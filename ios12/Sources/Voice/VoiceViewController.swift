import UIKit
import AVFoundation

// 变声：AVAudioEngine + AVAudioUnitTimePitch(音高) + AVAudioUnitDistortion(音色)。iOS 8+，iOS 12 可用。
// 实时试听（建议戴耳机）与录制回放。
final class VoiceViewController: UIViewController {

    private struct Preset {
        let name: String
        let pitchCents: Float                       // 100 音分 = 1 半音
        let distortion: AVAudioUnitDistortionPreset?
        let distWet: Float                          // 0~100
    }

    private let presets: [Preset] = [
        Preset(name: "🎙️原声", pitchCents: 0, distortion: nil, distWet: 0),
        Preset(name: "🐱汤姆猫", pitchCents: 450, distortion: .multiEcho1, distWet: 40),
        Preset(name: "🐷小猪佩奇", pitchCents: 560, distortion: nil, distWet: 0),
        Preset(name: "🐑喜羊羊", pitchCents: 650, distortion: nil, distWet: 0),
        Preset(name: "🐵孙悟空", pitchCents: 320, distortion: nil, distWet: 0),
        Preset(name: "🐗猪八戒", pitchCents: -420, distortion: nil, distWet: 0),
        Preset(name: "🐿️花栗鼠", pitchCents: 900, distortion: nil, distWet: 0),
        Preset(name: "🤖机器人", pitchCents: 0, distortion: .speechRadioTower, distWet: 60),
        Preset(name: "👹大魔王", pitchCents: -700, distortion: .speechCosmicInterference, distWet: 40),
    ]
    private var current = 0

    private let engine = AVAudioEngine()
    private let pitch = AVAudioUnitTimePitch()
    private let dist = AVAudioUnitDistortion()
    private var configured = false

    private var monitoring = false
    private var recording = false
    private var recordURL: URL?
    private var recordFile: AVAudioFile?
    private var player: AVAudioPlayer?

    private let statusLabel = UILabel()
    private let monitorButton = UIButton(type: .system)
    private let recordButton = UIButton(type: .system)
    private let playButton = UIButton(type: .system)
    private let stack = UIStackView()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "变声"
        view.backgroundColor = .white
        buildUI()
    }

    // MARK: - UI
    private func buildUI() {
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)

        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: g.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: -16),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor, constant: -32),
        ])

        let hint = UILabel()
        hint.text = "选择角色，按住试听（建议戴耳机，否则扬声器会啸叫）或录一段。"
        hint.numberOfLines = 0
        hint.font = .systemFont(ofSize: 13)
        hint.textColor = .gray
        stack.addArrangedSubview(hint)

        // 角色按钮网格（每行 3 个）
        var row: UIStackView? = nil
        for (i, p) in presets.enumerated() {
            if i % 3 == 0 {
                let r = UIStackView(); r.axis = .horizontal; r.distribution = .fillEqually; r.spacing = 8
                stack.addArrangedSubview(r); row = r
            }
            let b = UIButton(type: .system)
            b.setTitle(p.name, for: .normal)
            b.tag = i
            b.titleLabel?.font = .systemFont(ofSize: 15)
            b.layer.borderWidth = 1
            b.layer.borderColor = UIColor(white: 0.85, alpha: 1).cgColor
            b.layer.cornerRadius = 8
            b.heightAnchor.constraint(equalToConstant: 46).isActive = true
            b.addTarget(self, action: #selector(pickPreset(_:)), for: .touchUpInside)
            row?.addArrangedSubview(b)
        }

        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = UIColor(red: 0.08, green: 0.46, blue: 0.43, alpha: 1)
        statusLabel.numberOfLines = 0
        stack.addArrangedSubview(statusLabel)

        style(monitorButton, "🎧 实时试听")
        monitorButton.addTarget(self, action: #selector(toggleMonitor), for: .touchUpInside)
        stack.addArrangedSubview(monitorButton)

        style(recordButton, "⏺ 录一段")
        recordButton.addTarget(self, action: #selector(toggleRecord), for: .touchUpInside)
        stack.addArrangedSubview(recordButton)

        style(playButton, "▶️ 播放刚录的")
        playButton.addTarget(self, action: #selector(playLast), for: .touchUpInside)
        playButton.isEnabled = false
        stack.addArrangedSubview(playButton)

        highlightSelected()
    }

    private func style(_ b: UIButton, _ title: String) {
        b.setTitle(title, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        b.backgroundColor = UIColor(white: 0.96, alpha: 1)
        b.layer.cornerRadius = 10
        b.heightAnchor.constraint(equalToConstant: 48).isActive = true
    }

    @objc private func pickPreset(_ sender: UIButton) {
        current = sender.tag
        applyPreset()
        highlightSelected()
    }

    private func highlightSelected() {
        for v in stack.arrangedSubviews {
            guard let row = v as? UIStackView else { continue }
            for case let b as UIButton in row.arrangedSubviews {
                let on = b.tag == current
                b.backgroundColor = on ? UIColor(red: 0.06, green: 0.46, blue: 0.43, alpha: 1) : .white
                b.setTitleColor(on ? .white : .darkText, for: .normal)
            }
        }
    }

    private func applyPreset() {
        let p = presets[current]
        pitch.pitch = p.pitchCents
        if let dp = p.distortion {
            dist.loadFactoryPreset(dp)
            dist.wetDryMix = p.distWet
        } else {
            dist.wetDryMix = 0
        }
    }

    // MARK: - 引擎
    private func ensureEngine(_ done: @escaping (Bool) -> Void) {
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard granted else { self.statusLabel.text = "需要麦克风权限"; done(false); return }
                if !self.configured {
                    do {
                        let s = AVAudioSession.sharedInstance()
                        try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
                        try s.setActive(true)
                        self.engine.attach(self.pitch)
                        self.engine.attach(self.dist)
                        let fmt = self.engine.inputNode.inputFormat(forBus: 0)
                        self.engine.connect(self.engine.inputNode, to: self.pitch, format: fmt)
                        self.engine.connect(self.pitch, to: self.dist, format: fmt)
                        self.engine.connect(self.dist, to: self.engine.mainMixerNode, format: fmt)
                        self.applyPreset()
                        self.configured = true
                    } catch {
                        self.statusLabel.text = "音频初始化失败：\(error.localizedDescription)"
                        done(false); return
                    }
                }
                done(true)
            }
        }
    }

    private func startEngineIfNeeded() {
        engine.mainMixerNode.outputVolume = monitoring ? 1 : 0
        if !engine.isRunning {
            engine.prepare()
            try? engine.start()
        }
    }

    private func stopEngineIfIdle() {
        if !monitoring && !recording && engine.isRunning {
            engine.stop()
        }
    }

    @objc private func toggleMonitor() {
        if monitoring {
            monitoring = false
            monitorButton.setTitle("🎧 实时试听", for: .normal)
            engine.mainMixerNode.outputVolume = recording ? 0 : 0
            stopEngineIfIdle()
            statusLabel.text = recording ? "录音中…" : ""
        } else {
            ensureEngine { [weak self] ok in
                guard let self = self, ok else { return }
                self.monitoring = true
                self.monitorButton.setTitle("🔇 关闭试听", for: .normal)
                self.startEngineIfNeeded()
                self.statusLabel.text = "试听中：\(self.presets[self.current].name)（戴耳机避免啸叫）"
            }
        }
    }

    @objc private func toggleRecord() {
        if recording {
            engine.mainMixerNode.removeTap(onBus: 0)
            recordFile = nil
            recording = false
            recordButton.setTitle("⏺ 录一段", for: .normal)
            playButton.isEnabled = (recordURL != nil)
            stopEngineIfIdle()
            statusLabel.text = "已录制，点「播放刚录的」试听"
        } else {
            ensureEngine { [weak self] ok in
                guard let self = self, ok else { return }
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("voicefx.caf")
                let fmt = self.engine.mainMixerNode.outputFormat(forBus: 0)
                do {
                    self.recordFile = try AVAudioFile(forWriting: url, settings: fmt.settings)
                } catch {
                    self.statusLabel.text = "无法创建录音文件"; return
                }
                self.recordURL = url
                self.engine.mainMixerNode.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buffer, _ in
                    try? self?.recordFile?.write(from: buffer)
                }
                self.recording = true
                self.recordButton.setTitle("⏹ 停止录音", for: .normal)
                self.startEngineIfNeeded()
                self.statusLabel.text = "录音中：\(self.presets[self.current].name)"
            }
        }
    }

    @objc private func playLast() {
        guard let url = recordURL else { return }
        do {
            player = try AVAudioPlayer(contentsOf: url)
            player?.play()
            statusLabel.text = "播放中…"
        } catch {
            statusLabel.text = "播放失败：\(error.localizedDescription)"
        }
    }
}
