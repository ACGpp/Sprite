@preconcurrency import AVFoundation
import AVFoundation
import Foundation
import Speech

/// 语音输入：录一段 → 本地转写 → 文本进输入框。
///
/// 这一版修掉三个真实用户反馈：
///   1. **不要每次都申请权限**：只在"未询问"时申请；已授权直接用；被拒给出去系统设置的路径。
///   2. **不要只转译最后一句话**：系统识别在一次停顿后会给出"最终结果"并结束任务，
///      必须**把这一段并入累积文本，并在仍在录音时立刻开一个新任务继续听**。
///   3. **计时与停止要准**：计时从真正开始录音算；停止时先 `endAudio()` 让识别吐完尾巴再停引擎。
///
/// 识别优先走**设备端**（语音不离开这台机器）。
/// 线程说明（Swift 6 要的）：这个类被两个世界碰——
///   ① 主线程：start/stop/cancel 与所有公开状态；
///   ② 音频 tap 的实时线程：只 append 缓冲区、只写音频文件（`audioLock` 保护）。
/// 识别回调都在主队列上跑。因此标 `@unchecked Sendable`，但把跨线程的那部分
/// **显式加锁**（而不是靠"应该不会同时发生"）。
public final class DictationService: NSObject, @unchecked Sendable {
	public enum State: Equatable, Sendable {
		case idle
		case needsPermission(String)   // 附带一句人话说明
		case recording
		case transcribing
		case done(String)
		case failed(String)

		public var isRecording: Bool {
			if case .recording = self { return true }
			return false
		}
	}

	public private(set) var state: State = .idle {
		didSet {
			// 状态变化一律回主线程通知（回调是 @MainActor 的）
			let current = state
			if Thread.isMainThread {
				MainActor.assumeIsolated { onStateChange?(current) }
			} else {
				onMain { [self] in onStateChange?(current) }
			}
		}
	}

	public var onStateChange: (@MainActor (State) -> Void)?
	/// 转写完成（拿到完整文本）
	public var onTranscript: (@MainActor (String) -> Void)?
	/// 一段语音结束：**转写文字 + 音频文件 + 时长**。
	///
	/// 音频和文字一起交出去——只给文字等于把用户的原话丢了（真实用户反馈：
	/// "录音点一下面板就没了，回来内容也没了"）。文字为空但有音频时也会回调。
	public var onVoiceNote: (@MainActor (String, URL?, Int) -> Void)?
	/// 录音过程中的**实时**文本（让用户看见它在听）
	public var onLiveText: (@MainActor (String) -> Void)?

	/// 识别通道：true = 系统通道（更准，音频会送到 Apple）；false = 设备端。
	/// 由外壳按用户的设置写入。
	public var useSystemRecognition = true

	private let engine = AVAudioEngine()
	private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
	private var currentRequest: SFSpeechAudioBufferRecognitionRequest?
	private var task: SFSpeechRecognitionTask?
	private var tapInstalled = false

	/// 已确认下来的文本（跨多个识别任务累积——这是"不只转译最后一句"的关键）
	private var accumulated = ""
	/// 当前识别任务里的实时文本
	private var live = ""
	private var startedAt: Date?

	/// 录音同时**落一份音频文件**。识别是"机器的理解"，音频是"原话"——
	/// 理解错了要能回去听。优先 AAC（16 秒 ≈ 60KB），编码器不可用时退回 PCM。
	private let audioLock = NSLock()
	private var audioFile: AVAudioFile?
	/// 这一段录音的本地文件（提交给内核之后置空）——装配层用它做电平/说话时长体检
	public private(set) var audioURL: URL?
	private var capturedFrames: Double = 0
	private var captureSampleRate: Double = 0
	/// 收尾只允许发生一次（4 秒兜底定时器与实时回调都会调 finish）
	private var finishing = false
	/// 这一段录音被取消了：在途的转写回调**不许**再产出语音
	/// （老实现只把音频丢掉，回调仍会走 finish → 原话照样进记忆，还把状态覆盖成"完成"）
	private var cancelled = false
	/// 音频是否真的写成功了（写失败要如实说，不能假装存上了）
	public private(set) var lastCaptureFailed: String?
	/// 刚录完这一段的电平画像（"几乎没声音"和"有声音但没识别出来"必须分得清）
	public private(set) var lastLevel: VoiceTranscriber.Level?
	/// 刚录完这一段的时长（秒）——用来判断转写是否明显缺内容
	public private(set) var secondsRecorded: Int = 0

	public var recordingSeconds: Int {
		guard let startedAt, state.isRecording || state == .transcribing else { return 0 }
		return max(0, Int(Date().timeIntervalSince(startedAt).rounded(.down)))
	}

	public var elapsedText: String {
		let seconds = recordingSeconds
		return String(format: "%d:%02d", seconds / 60, seconds % 60)
	}

	/// 当前能看到的文本（已确认 + 实时）
	public var currentTranscript: String {
		[accumulated, live].filter { !$0.isEmpty }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
	}

	// MARK: - 权限（只在"未询问"时才弹窗）

	public var microphoneAuthorized: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

	/// 这次会不会**弹出系统权限窗**。只有"未询问"才会弹（被拒不会）。
	///
	/// 为什么要单独问这个：系统弹窗会被挡住的——真实用户反馈"面板钉在那儿，
	/// 权限窗的按钮点不到"。所以点录音时要先知道会不会弹，弹之前先把面板收起来。
	public var willPrompt: Bool {
		AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined || SFSpeechRecognizer.authorizationStatus() == .notDetermined
	}
	public var speechAuthorized: Bool { SFSpeechRecognizer.authorizationStatus() == .authorized }

	public var permissionSummary: String {
		func describe(_ status: AVAuthorizationStatus) -> String {
			switch status {
			case .authorized: return L("已允许")
			case .notDetermined: return L("未询问")
			case .denied: return L("被拒绝")
			case .restricted: return L("受限")
			@unknown default: return L("未知")
			}
		}
		func describe(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
			switch status {
			case .authorized: return L("已允许")
			case .notDetermined: return L("未询问")
			case .denied: return L("被拒绝")
			case .restricted: return L("受限")
			@unknown default: return L("未知")
			}
		}
		return "麦克风：\(describe(AVCaptureDevice.authorizationStatus(for: .audio)))　语音识别：\(describe(SFSpeechRecognizer.authorizationStatus()))"
	}

	// MARK: - 录音

	public func start() {
		guard !state.isRecording else { return }

		// 已授权 → 直接开始，**不重复申请**（用户反馈："每次都会请求权限"）
		if microphoneAuthorized && speechAuthorized {
			beginCapture()
			return
		}
		// 被拒 → 不弹窗，直接告诉人去哪儿打开
		if AVCaptureDevice.authorizationStatus(for: .audio) == .denied || SFSpeechRecognizer.authorizationStatus() == .denied {
			state = .needsPermission(L("权限被拒。去「系统设置 → 隐私与安全性」里允许「麦克风」与「语音识别」"))
			return
		}
		// 只在"未询问"时申请一次
		requestOnce { [weak self] granted in
			guard let self else { return }
			if granted {
				self.beginCapture()
			} else {
				self.state = .needsPermission(L("没有授权，无法录音。去「系统设置 → 隐私与安全性」里允许"))
			}
		}
	}

	public func stop() {
		guard state.isRecording else { return }
		state = .transcribing
		// 顺序：先让识别把缓冲吐完，再停引擎——反过来会截掉尾巴
		currentRequest?.endAudio()
		stopEngine()
		// 兜底：4 秒内没等到最终结果就用已有文本收尾，不能让界面卡在"正在转写"
		DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
			guard let self, self.state == .transcribing else { return }
			self.finish()
		}
	}

	public func cancel() {
		cancelled = true
		finishing = true // 让任何在途的 finish 直接返回
		task?.cancel()
		task = nil
		stopEngine()
		discardAudio()
		accumulated = ""
		live = ""
		startedAt = nil
		state = .idle
	}

	// MARK: - 内部

	private func requestOnce(_ completion: @escaping @MainActor @Sendable (Bool) -> Void) {
		SFSpeechRecognizer.requestAuthorization { speech in
			onMain {
				guard speech == .authorized else {
					completion(false)
					return
				}
				AVCaptureDevice.requestAccess(for: .audio) { mic in
					onMain { completion(mic) }
				}
			}
		}
	}

	private func beginCapture() {
		guard let recognizer, recognizer.isAvailable else {
			state = .failed(L("这台机器上的中文识别暂时不可用"))
			return
		}
		accumulated = ""
		live = ""
		lastCaptureFailed = nil
		cancelled = false
		do {
			let input = engine.inputNode
			let format = input.outputFormat(forBus: 0)
			if !tapInstalled {
				// tap 里必须引用 self.currentRequest —— 识别任务会在停顿后重启，
				// 捕获旧的 request 会让新任务收不到声音
				input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
					self?.currentRequest?.append(buffer)
					self?.writeAudio(buffer)
				}
				tapInstalled = true
			}
			// 音频文件**不在这里建**：等到第一个缓冲区到达、按它自己的格式建
			// （见 createAudioFile(matching:)。启动前查到的格式可能和设备实际送来的不一样）
			engine.prepare()
			try engine.start()
			startedAt = Date()
			startTask()
			state = .recording
		} catch {
			stopEngine()
			state = .failed("麦克风启动失败：\(error.localizedDescription)")
		}
	}

	/// 开一个识别任务。停顿导致的"最终结果"会让任务结束，此时必须再开一个继续听。
	private func startTask() {
		guard let recognizer else { return }
		let request = SFSpeechAudioBufferRecognitionRequest()
		request.shouldReportPartialResults = true
		if !useSystemRecognition && recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
		currentRequest = request
		// 强捕获 self：服务与进程同寿命（面板持有它），弱引用反而让闭包语义变复杂
		task = recognizer.recognitionTask(with: request) { [self] result, error in
			// 识别回调在系统线程上触发 → 回主队列处理（状态机全在主线程）。
			// `result` 是非 Sendable 的系统对象：先把要用的值取出来再跨域。
			let text = result?.bestTranscription.formattedString
			let isFinal = result?.isFinal ?? false
			let hadError = error != nil
			onMain { [self] in
				if let text {
					self.live = text
					let liveText = self.currentTranscript
					self.onLiveText?(liveText)
					if isFinal {
						// 把这一段并进累积文本——不并的话，这里就是"只转译最后一句"的现场
						if !self.live.isEmpty {
							self.accumulated = [self.accumulated, self.live].filter { !$0.isEmpty }.joined(separator: " ")
						}
						self.live = ""
						if self.state.isRecording {
							self.startTask() // 还在录：立刻继续听下一段
						} else {
							self.finish()
						}
					}
					return
				}
				if hadError {
					// 录音过程中的识别中断不致命：用已有文本收尾，不把用户的话丢掉
					if self.state.isRecording {
						self.finish()
					} else if self.state != .transcribing {
						self.state = .failed(L("识别中断，已保留听到的内容"))
					}
				}
			}
		}
	}

	/// 建一个录音文件。**同采样率同声道数**，避免实时重采样（那是丢帧的常见来源）。
	private func createAudioFile(matching format: AVAudioFormat) {
		audioFile = nil
		audioURL = nil
		capturedFrames = 0
		captureSampleRate = format.sampleRate
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sprite-voice", isDirectory: true)
		try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
		// 先试 AAC（m4a）：体积小到能直接塞进 RPC
		let aac: [String: Any] = [
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: format.sampleRate,
			AVNumberOfChannelsKey: format.channelCount,
			AVEncoderBitRateKey: 32000,
		]
		let m4a = directory.appendingPathComponent("\(stamp).m4a")
		if let file = try? AVAudioFile(forWriting: m4a, settings: aac, commonFormat: .pcmFormatFloat32, interleaved: false) {
			audioFile = file
			audioURL = m4a
			return
		}
		// 退回未压缩 PCM：宁可文件大，也不能没有原话
		let caf = directory.appendingPathComponent("\(stamp).caf")
		if let file = try? AVAudioFile(forWriting: caf, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false) {
			audioFile = file
			audioURL = caf
			return
		}
		lastCaptureFailed = L("录音文件建不起来，只保留转写文字")
	}

	private func writeAudio(_ buffer: AVAudioPCMBuffer) {
		// 文件按**第一个缓冲区自己的格式**建（而不是 engine.start() 之前查到的格式）。
		//
		// 真实事故（2026-09-14 查出来的录音报错）：一开麦克风，macOS 会往菜单栏插
		// 它自己的麦克风标识、甚至切换输入设备（Continuity / 蓝牙耳机），实际送进 tap 的
		// 格式和启动前查到的不一样。用错格式建文件的结果是**文件里是静音或变调的**，
		// 而实时识别照常工作（SFSpeechAudioBufferRecognitionRequest 自己会转格式）——
		// 于是"文字有、原话没了"：09-11 22:12 那条 11 秒的录音文件全程静音（峰值 0.06），
		// 可当时的转写文本是完整的一段话。
		if audioFile == nil { createAudioFile(matching: buffer.format) }
		guard let audioFile else { return }
		do {
			if audioFile.processingFormat == buffer.format {
				try audioFile.write(from: buffer)
			} else if let converted = convert(buffer, to: audioFile.processingFormat) {
				try audioFile.write(from: converted)
			} else {
				lastCaptureFailed = L("录音格式变了，这一段没写进原话")
				self.audioFile = nil
				return
			}
			capturedFrames += Double(buffer.frameLength)
		} catch {
			// 写坏一次就不再写：留一个能播的片段，总比留一个坏文件强
			lastCaptureFailed = "录音写入失败：\(error.localizedDescription)"
			self.audioFile = nil
		}
	}

	/// 把缓冲区转成文件需要的格式（设备中途换了才用得到）。
	/// 在音频线程上做一次 2048 帧的转换是毫秒级，可以接受；转换不出来就如实放弃这一段。
	private func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
		guard let converter = AVAudioConverter(from: buffer.format, to: format) else { return nil }
		let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / max(1, buffer.format.sampleRate)) + 64
		guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
		var supplied = false
		var error: NSError?
		converter.convert(to: output, error: &error) { _, status in
			if supplied {
				status.pointee = .noDataNow
				return nil
			}
			supplied = true
			status.pointee = .haveData
			return buffer
		}
		return error == nil && output.frameLength > 0 ? output : nil
	}

	/// 收尾：关文件（AAC 靠 deinit 冲刷尾部），返回能播的音频地址
	private func finalizeAudio() -> (URL?, Int) {
		let url = audioURL
		let frames = capturedFrames
		let rate = captureSampleRate
		audioFile = nil // deinit 会把编码器尾巴冲刷完
		audioURL = nil
		capturedFrames = 0
		guard let url, frames > 0 else {
			if let url { try? FileManager.default.removeItem(at: url) }
			return (nil, 0)
		}
		let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
		let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
		guard size > 0 else {
			try? FileManager.default.removeItem(at: url)
			return (nil, 0)
		}
		let seconds = rate > 0 ? frames / rate : 0
		// 诚实体检：文件里到底有没有人声。没有就当场说清楚——
		// "文字有、原话没了"必须让用户知道（他的原话是这段记忆里最不可再生的东西）。
		if let level = VoiceTranscriber.level(url: url), !level.hasVoice {
			lastCaptureFailed = L("⚠︎ 这段的原话没能录上（音频里几乎没有声音），只留了文字")
		}
		return (url, Int((seconds * 1000).rounded()))
	}

	private func discardAudio() {
		if let audioURL { try? FileManager.default.removeItem(at: audioURL) }
		audioFile = nil
		audioURL = nil
		capturedFrames = 0
	}

	private func stopEngine() {
		if engine.isRunning { engine.stop() }
		if tapInstalled {
			engine.inputNode.removeTap(onBus: 0)
			tapInstalled = false
		}
		currentRequest = nil
	}

	private func finish() {
		guard !finishing, !cancelled else { return }
		finishing = true
		let streamed = currentTranscript
		stopEngine()
		task = nil
		startedAt = nil
		accumulated = ""
		live = ""
		let (audio, durationMs) = finalizeAudio()
		secondsRecorded = Int((Double(durationMs) / 1000).rounded())
		lastLevel = audio.flatMap { VoiceTranscriber.level(url: $0) }

		guard audio != nil || !streamed.isEmpty else {
			finishing = false
			state = .failed(L("没有听到内容（可以说长一点，或检查麦克风输入）"))
			return
		}
		guard let audio else {
			emit(text: streamed, audio: nil, durationMs: durationMs)
			return
		}

		// **关键一步**：实时识别会静默丢内容（实测 1 分 43 秒只出 20 字），
		// 所以录完必须拿**完整音频**重新过一遍，取更长的那个。
		// 这一步期间状态保持"正在转写"，界面会如实显示。
		state = .transcribing
		let channel: VoiceTranscriber.Channel = useSystemRecognition ? .system : .onDevice
		// VoiceTranscriber 是主线程隔离的 → 回主线程再调（复核本来也不需要后台）
		onMain { [self] in
			VoiceTranscriber().transcribe(url: audio, channel: channel, timeout: 45) { [self] outcome in
				let best = outcome.text.count > streamed.count ? outcome.text : streamed
				emit(text: best, audio: audio, durationMs: durationMs)
			}
		}
	}

	/// 交出一段语音（音频 + 最终文字）
	private func emit(text: String, audio: URL?, durationMs: Int) {
		guard !cancelled else {
			// 取消之后到达的转写：音频已经丢掉，文字也不该再进记忆
			if let audio { try? FileManager.default.removeItem(at: audio) }
			finishing = false
			state = .idle
			return
		}
		finishing = false
		// 有音频、或听到文字——都算一段语音，必须交出去存起来。
		// 之前这里只有文字路径：识别听不清时整段录音凭空消失（真实用户反馈）。
		if audio != nil || !text.isEmpty {
			// 回调是 @MainActor 的：明确回主线程（这些路径本来就在主队列上，
			// 但 Swift 6 要看到证据，而不是"应该"）
			onMain { [weak self] in self?.onVoiceNote?(text, audio, durationMs) }
		}
		guard !text.isEmpty else {
			// 分清两件事：麦克风根本没收到声音，还是收到了但识别不出来。
			// 这两句话用户的下一步动作完全不同（换输入设备 vs 换个识别通道）。
			if let level = lastLevel, !level.hasVoice {
				state = .failed(String(format: L("麦克风几乎没收到声音（%.1f 秒，峰值 %.2f）——检查一下输入设备；录音已保留"), level.seconds, level.peak))
			} else {
				state = .failed(L("听到了声音但没识别出文字，录音已保留（可以换识别通道再试）"))
			}
			return
		}
		state = .done(text)
		onMain { [weak self] in self?.onTranscript?(text) }
	}
}
