import AVFoundation
import CoreAudio
import Foundation
import Speech

/// 现在用的是哪个输入设备。
///
/// 真实用户反馈里最要命的一句是"让我选择这个麦克风模式"——他不知道声音是从哪儿进来的。
/// 录音界面必须能说出这句话：**当前用的是哪个麦克风**。
public enum AudioInput {
	public static func currentDeviceName() -> String? {
		var deviceID = AudioDeviceID(0)
		var size = UInt32(MemoryLayout<AudioDeviceID>.size)
		var address = AudioObjectPropertyAddress(
			mSelector: kAudioHardwarePropertyDefaultInputDevice,
			mScope: kAudioObjectPropertyScopeGlobal,
			mElement: kAudioObjectPropertyElementMain
		)
		guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr, deviceID != 0 else {
			return nil
		}
		// 设备名是 CFString：用 Unmanaged 承接所有权，避免把对象引用当裸指针传来传去
		var name: Unmanaged<CFString>?
		var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
		var nameAddress = AudioObjectPropertyAddress(
			mSelector: kAudioObjectPropertyName,
			mScope: kAudioObjectPropertyScopeGlobal,
			mElement: kAudioObjectPropertyElementMain
		)
		guard AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &name) == noErr,
			let value = name?.takeRetainedValue()
		else { return nil }
		return value as String
	}
}

/// 对**已经录好的音频文件**做转写。
///
/// 为什么需要它：设备端识别会**静默返回空**（同一个文件换系统通道就能识别出来，
/// 实测：设备端 0 字、系统通道 102 字，且不报任何错）。实时识别走的是同一条路，
/// 所以"录了 50 秒、音频里有人声、转写却是空的"是真实会发生的事。
///
/// 两条通道的区别必须对用户说清楚：
///   - 设备端（`requiresOnDeviceRecognition`）：语音不离开这台机器；
///   - 系统通道：音频会送到 Apple 的服务器。
/// 所以**默认只走设备端**，"用系统通道"必须由用户点按钮决定，不偷偷替用户做主。
/// "只生效一次"的收尾器：识别回调与超时定时器都可能调它。
/// 主线程隔离（两个来源都会回主线程），所以不需要锁。
@MainActor
private final class FinishOnce {
	private var done = false
	private let completion: (VoiceTranscriber.Outcome) -> Void
	init(completion: @escaping (VoiceTranscriber.Outcome) -> Void) { self.completion = completion }
	func finish(_ outcome: VoiceTranscriber.Outcome) {
		guard !done else { return }
		done = true
		completion(outcome)
	}
}

public final class VoiceTranscriber {
	public struct Outcome: Sendable {
		public let text: String
		/// 用了哪条通道 / 失败原因（要如实显示给用户）
		public let channel: String
		public var ok: Bool { !text.isEmpty }
	}

	public enum Channel: Sendable {
		case onDevice
		case system
	}

	private let locale: Locale

	public init(locale: Locale = Locale(identifier: "zh-CN")) {
		self.locale = locale
	}

	/// 转写一个本地音频文件。**整个方法在主线程跑**（界面调它），回调也在主线程。
	@MainActor
	public func transcribe(url: URL, channel: Channel = .onDevice, timeout: TimeInterval = 60, completion: @escaping @MainActor @Sendable (Outcome) -> Void) {
		guard let recognizer = SFSpeechRecognizer(locale: locale) else {
			completion(Outcome(text: "", channel: "这台机器上没有中文识别器"))
			return
		}
		guard recognizer.isAvailable else {
			completion(Outcome(text: "", channel: "识别器当前不可用"))
			return
		}
		let request = SFSpeechURLRecognitionRequest(url: url)
		request.shouldReportPartialResults = true
		let onDevice = channel == .onDevice && recognizer.supportsOnDeviceRecognition
		request.requiresOnDeviceRecognition = onDevice
		let label = onDevice ? "设备端（语音不出这台机器）" : "系统通道（音频会送到 Apple）"

		// 超时兜底：识别任务有可能既不回结果也不报错（真实发生过），不能让界面一直等。
		// 两条路径（识别回调 / 超时）都会 finish：用主线程隔离的容器保证只生效一次。
		let once = FinishOnce(completion: completion)
		DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
			onMain { once.finish(Outcome(text: "", channel: "\(label)：等了 \(Int(timeout)) 秒没有结果")) }
		}
		let finish: @Sendable (Outcome) -> Void = { outcome in onMain { once.finish(outcome) } }

		recognizer.recognitionTask(with: request) { result, error in
			// 识别回调在系统线程上触发 → 收尾一律回主线程（finish 会进 UI 状态）。
			// result 是非 Sendable 的系统对象：先在原线程取出字符串，再跨域。
			let text = result?.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
			let isFinal = result?.isFinal ?? false
			let message = error?.localizedDescription
			onMain {
			if let text {
				if isFinal {
					finish(Outcome(text: text, channel: text.isEmpty ? "\(label)：听不出内容" : label))
				}
				return
			}
			if let message {
				finish(Outcome(text: "", channel: "\(label)：\(message)"))
			}
			}
		}
	}

	/// 先设备端，没听出来再走系统通道。
	///
	/// **只在用户点了按钮时才走第二条**——它意味着音频要出机器。
	@MainActor
	public func transcribeWithFallback(url: URL, allowSystem: Bool, completion: @escaping @MainActor @Sendable (Outcome) -> Void) {
		transcribe(url: url, channel: .onDevice) { [weak self] first in
			if first.ok || !allowSystem {
				completion(first)
				return
			}
			self?.transcribe(url: url, channel: .system) { second in
				if second.ok {
					completion(Outcome(text: second.text, channel: "设备端没听出来，系统通道听出来的（音频已送到 Apple）"))
				} else {
					completion(Outcome(text: "", channel: "两条通道都没听出来：\(first.channel) / \(second.channel)"))
				}
			}
		}
	}

	/// 音频的电平画像：用来区分"麦克风没收到声音"和"有声音但识别不出来"。
	public struct Level: Sendable {
		public let seconds: Double
		public let peak: Float
		/// 音频里**真的有说话声**的秒数（100ms 窗、RMS 高于阈值才算）。
		///
		/// 为什么需要它：判断"转写是不是缺了内容"必须用说话时长，不能用录音总长——
		/// 录音里有停顿和沉默，用总长会把"15 秒里说了 10 个字"误判成不完整
		/// （真实反馈：那条"看起来不完整"的提示一直存在，其实话本身就是短的）。
		public let speechSeconds: Double
		public var hasVoice: Bool { peak >= 0.10 }
	}

	public static func level(url: URL) -> Level? {
		guard let file = try? AVAudioFile(forReading: url) else { return nil }
		let format = file.processingFormat
		let capacity = AVAudioFrameCount(max(1, format.sampleRate))
		guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
		var peak: Float = 0
		var frames: AVAudioFramePosition = 0
		// 说话秒数：按 100ms 的窗算 RMS，超过阈值才算"这一段有人在说话"
		let windowFrames = max(1, Int(format.sampleRate / 10))
		var windowSum: Double = 0
		var windowCount = 0
		var speechWindows = 0
		let speechRMS: Double = 0.012
		while file.framePosition < file.length {
			guard (try? file.read(into: buffer, frameCount: capacity)) != nil, buffer.frameLength > 0 else { break }
			guard let data = buffer.floatChannelData?[0] else { break }
			for index in 0..<Int(buffer.frameLength) {
				let sample = Double(data[index])
				peak = max(peak, Float(abs(sample)))
				windowSum += sample * sample
				windowCount += 1
				if windowCount >= windowFrames {
					let rms = (windowSum / Double(windowCount)).squareRoot()
					if rms > speechRMS { speechWindows += 1 }
					windowSum = 0
					windowCount = 0
				}
			}
			frames += AVAudioFramePosition(buffer.frameLength)
		}
		// 收尾那不足一窗的尾巴：只要有一段响就算
		if windowCount > 0, (windowSum / Double(windowCount)).squareRoot() > speechRMS { speechWindows += 1 }
		let seconds = format.sampleRate > 0 ? Double(frames) / format.sampleRate : 0
		let speechSeconds = min(seconds, Double(speechWindows) / 10)
		return Level(seconds: seconds, peak: peak, speechSeconds: speechSeconds)
	}

	/// 音频里到底有没有声音——"没有文字"和"没有声音"是两回事，界面上要分得清。
	public static func levelSummary(url: URL) -> String? {
		guard let level = level(url: url) else { return nil }
		if !level.hasVoice {
			return String(format: "%.1f 秒，几乎没有声音（峰值 %.2f）", level.seconds, level.peak)
		}
		return String(format: "%.1f 秒，其中约 %.1f 秒有说话声（峰值 %.2f）", level.seconds, level.speechSeconds, level.peak)
	}

	/// 旧版摘要（仅电平数值），保留给不需要秒数的调用方
	public static func legacyLevelSummary(url: URL) -> String? {
		guard let file = try? AVAudioFile(forReading: url) else { return nil }
		let format = file.processingFormat
		let capacity = AVAudioFrameCount(max(1, format.sampleRate))
		guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
		var peak: Float = 0
		var frames: AVAudioFramePosition = 0
		while file.framePosition < file.length {
			guard (try? file.read(into: buffer, frameCount: capacity)) != nil, buffer.frameLength > 0 else { break }
			guard let data = buffer.floatChannelData?[0] else { break }
			for index in 0..<Int(buffer.frameLength) { peak = max(peak, abs(data[index])) }
			frames += AVAudioFramePosition(buffer.frameLength)
		}
		let seconds = format.sampleRate > 0 ? Double(frames) / format.sampleRate : 0
		if peak < 0.01 { return String(format: "%.1f 秒，几乎没有声音", seconds) }
		return String(format: "%.1f 秒，有声音（峰值 %.2f）", seconds, peak)
	}
}
