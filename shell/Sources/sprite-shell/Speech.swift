import AppKit
import AVFoundation
import Speech

/// 原生语音：朗读用 AVSpeechSynthesizer（零下载），听写用系统识别（不打包模型）。
///
/// 诚实的两点：
///   1. 中文识别资源由系统按需安装（实测 AssetInventory.status == supported 而非 installed），
///      首次使用可能需要一次系统资源安装——UI 必须如实告知，不能宣传"零下载"。
///   2. 麦克风与语音识别都需要用户授权；未授权时功能不可用，但文字输入永远可用。
public final class SpeechService: NSObject {
	private let synthesizer = AVSpeechSynthesizer()
	private var lastSpoken: String?

	public override init() {
		super.init()
	}

	// MARK: - 朗读

	public var isSpeaking: Bool { synthesizer.isSpeaking }

	public func speak(_ text: String) {
		guard !text.isEmpty else { return }
		if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
		let utterance = AVSpeechUtterance(string: text)
		utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
		utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.94
		synthesizer.speak(utterance)
		lastSpoken = text
	}

	public func stopSpeaking() {
		synthesizer.stopSpeaking(at: .immediate)
	}

	// MARK: - 听写

	public enum DictationState: String {
		case idle
		case unauthorized
		case unavailable
		case ready
	}

	/// 只查询能力，不申请权限、不录音。
	public func dictationState() -> DictationState {
		guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else { return .unavailable }
		switch SFSpeechRecognizer.authorizationStatus() {
		case .authorized: return recognizer.isAvailable ? .ready : .unavailable
		case .notDetermined: return .unauthorized
		case .denied, .restricted: return .unauthorized
		@unknown default: return .unavailable
		}
	}

	public var dictationDescription: String {
		switch dictationState() {
		case .ready: return "可以按住说话"
		case .unauthorized: return "需要你在系统设置里允许语音识别"
		case .unavailable: return "这台机器暂时不可用"
		case .idle: return "空闲"
		}
	}

	/// 首次真正要用的时候才申请授权（不在启动时弹窗打扰人）
	public func requestDictationPermission(completion: @escaping @MainActor @Sendable (Bool) -> Void) {
		SFSpeechRecognizer.requestAuthorization { status in
			let granted = status == .authorized
			onMain { completion(granted) }
		}
	}

	/// macOS 26 的本地识别模块是否支持中文（只读查询，不触发下载）
	public func localTranscriberSupportsChinese() -> Bool? {
		if #available(macOS 26.0, *) {
			return nil // 需要 async 查询 supportedLocales；见 sprite-rpc-probe 的语音探针
		}
		return nil
	}
}
