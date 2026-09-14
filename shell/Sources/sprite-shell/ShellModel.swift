import AVFoundation
import Foundation
import SpriteRPC

/// 请求打开记录窗口的哪个分区
public enum RecordsSectionRequest {
	case live
	case voice
	case diary
	case settings
}

/// 外壳状态：把内核事件折叠成界面需要的东西。
///
/// 原则：界面上的每一个数字都来自内核事件，外壳不做任何推断。
/// 唯一的例外是倒计时的逐秒递减（那是显示层的时间流逝，不是状态）。
/// 主线程隔离：`@Published` 状态只允许在主线程改（SwiftUI 的约定），
/// 后台 RPC 一律"先在主线程取好 client / 参数，再派发，回来用 `onMain` 写状态"。
/// 这也是 Swift 6 并发检查要求的结构——以前靠自觉，现在由编译器守。
@MainActor
public final class ShellModel: ObservableObject {
	public private(set) var state: KernelState?
	public private(set) var snapshot: KernelSnapshot?
	public private(set) var lastEventSeq: Int = 0
	@Published public private(set) var connected = false
	@Published public private(set) var connectionError: String?

	/// 真实呼吸节奏（毫秒），来自 breath.scheduled 事件——不是动画参数
	public private(set) var intervalMs: Double?
	/// 下一次醒来的时刻（来自内核，不是本地估算）
	public private(set) var nextBreathAt: Date?

	/// 界面刷新（SwiftUI 的 objectWillChange 由它驱动）
	public var onChange: (() -> Void)? {
		didSet { }
	}

	// 纯函数：只读 JSONValue，不碰任何状态 → nonisolated，主线程/后台都能用
	private nonisolated func string(_ value: JSONValue?) -> String? { value?.stringValue }
	private nonisolated func int(_ value: JSONValue?) -> Int? { value?.numberValue.map { Int($0) } }

	/// 后台发一次请求 → **回主线程**把结果交给调用方。
	///
	/// 请求与响应都装箱：两者在构造之后都不再被改，是"不可变快照"，
	/// 跨隔离域传递本来就是安全的——这个箱子就是把这句话说给编译器听。
	/// 解析一律在主线程做（`finish` 是 `@MainActor`），避免非 Sendable 的值漏到后台。
	private func requestInBackground(
		_ payload: [String: Any],
		client: CoreClient?,
		then finish: @escaping @MainActor @Sendable (JSONValue?, String?) -> Void
	) {
		let requestBox = Immutable(payload)
		DispatchQueue.global(qos: .userInitiated).async {
			guard let client else {
				onMain { finish(nil, nil) }
				return
			}
			do {
				let response = try client.requestRaw(requestBox.value)
				let responseBox = Immutable(response)
				onMain { finish(responseBox.value, nil) }
			} catch {
				let message = String(describing: error)
				onMain { finish(nil, message) }
			}
		}
	}

	/// 后台写一次、主线程读一次的结果箱子（跨隔离域传"一次性结果"用）
	final class ResultBox: @unchecked Sendable {
		private let lock = NSLock()
		private var stored: String?
		func set(_ value: String) {
			lock.lock()
			stored = value
			lock.unlock()
		}
		var value: String? {
			lock.lock()
			defer { lock.unlock() }
			return stored
		}
	}

	/// 把**不可变**的请求体/解析结果带进后台闭包。
	///
	/// 为什么需要它：`[String: Any]` 与 `[String: JSONValue]` 都不是 Sendable，
	/// Swift 6 不许它们跨隔离域。而这些值在构造之后就不再被改，等价的
	/// "只读快照"本来就是安全的——用一个显式的箱子把这件事说出来，
	/// 而不是给整个类型加 `@unchecked` 把它盖过去。
	struct Immutable<Value>: @unchecked Sendable {
		let value: Value
		init(_ value: Value) { self.value = value }
	}

	/// 把路径里的家目录缩成 `~`：界面上（截图、投屏）不该暴露用户名
	public static func tilde(_ path: String) -> String {
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		guard !home.isEmpty, path.hasPrefix(home) else { return path }
		return "~" + path.dropFirst(home.count)
	}

	/// 它的名字（内核给的；拿不到就退回"它"）
	public var companionName: String? { state?.companionName }

	/// 对话流里的一条。
	///
	/// 面板和记录窗口的「现在」用的是**同一份**对话流——同一句话只有一个显示位置，
	/// 不再出现"面板里有一条、屏幕中间又弹一张卡"的重复。
	public typealias Turn = ConversationTurn

	/// 对话流：我说的 + 它说的，按 journal 的 seq 排（seq 是唯一的因果顺序）。
	///
	/// 已发送但内核还没回显的那几句放在最末尾（它们是刚发生的），标成 pending——
	/// 这样点了发送立刻能看到，而不是等一个呼吸周期。
	public var conversation: [Turn] {
		Conversation.merge(
			messages: state?.messages ?? [],
			outgoing: state?.outgoing ?? [],
			optimistic: optimisticIncoming
		)
	}


	/// 「现在」用的对话流：**不含导入的旧历史**（归档在「对话记录」里看）
	public var liveConversation: [Turn] {
		Conversation.live(conversation)
	}

	/// 归档里还有多少条更早的（界面上要如实指个路）
	public var archivedTurnCount: Int {
		conversation.filter(\.imported).count
	}

	/// 它在想事情吗（有等待感的那一段）
	public var isThinking: Bool { state?.presence == .thinking }
	/// 已经想了多久（秒）——由图标心跳每 0.1 秒刷新，只在整数变化时更新
	@Published public var thinkingSeconds = 0
	/// 我最后说那句话的时刻（"它在想"的计时起点）
	private var lastIncomingAt: Date? {
		state?.messages.last(where: { ($0.imported ?? false) == false }).flatMap { Self.parse($0.at) }
	}

	/// 由心跳调用：把"它在想多久"算出来（只在数字变了才发通知，避免无意义重绘）
	public func refreshThinkingClock() {
		guard isThinking, let started = lastIncomingAt else {
			if thinkingSeconds != 0 { thinkingSeconds = 0 }
			return
		}
		let seconds = max(0, Int(Date().timeIntervalSince(started)))
		if thinkingSeconds != seconds { thinkingSeconds = seconds }
	}

	/// ⌥K／点「回一句」时把光标送进输入框——多轮对话里这一步不该让人再点一次
	@Published public var focusInputToken = 0
	public func requestInputFocus() { focusInputToken += 1 }

	/// 它最近说的一句话（下拉面板的主角）
	public var lastWords: String? {
		state?.outgoing.last(where: { $0.imported != true })?.text
			?? state?.outgoing.last?.text
	}

	/// 出声（在家模式）/ 不出声（办公模式）——设置项，由下拉面板切换
	@Published public var speakAloud = false

	/// 打开记录窗口（由 AppDelegate 接线）；参数是要打开的分区
	public var onOpenRecords: ((RecordsSectionRequest) -> Void)?
	/// 记录窗口的「现在」是否正开着——开着就不弹说话卡片（同一句话不显示两遍）
	public var onLiveSectionChange: ((Bool) -> Void)?
	/// 它说话了（在家模式下由 AppDelegate 决定要不要朗读）
	public var onSpeechRequest: ((String) -> Void)?
	/// 刚转写出来的文字（放进输入框，不自动发送）
	@Published public var pendingTranscript: String?

	/// 输入框内容**住在模型里**，不住在视图里。
	///
	/// 真实用户反馈：录音时面板被关掉，回来后"内容丢失"。原因是字存在视图的 @State
	/// 里、而转写结果从来没被视图读过。状态放在模型里，面板开关多少次都不会丢。
	@Published public var draft = ""

	/// 语音归档结果（存到哪儿了 / 为什么没存上）——如实说，不假装成功
	@Published public var archiveNote: String?
	/// 记录读取失败的原因（不吞错：读不到就说读不到，不能显示成"没有记录"）
	@Published public var recordsError: String?

	// ─── 设置（模型 / 安静时段 / 主动说话）───

	/// 内核给的可选项与当前值（**永远不含密钥值**，只有 hasApiKey）
	public typealias Settings = KernelSettings

	@Published public var settings: KernelSettings?
	/// 保存结果（如实说：存没存上、引擎有没有换、哪儿失败了）
	@Published public var settingsNote: String?
	@Published public var settingsSaving = false
	/// 这家供应商能用的模型（问内核要；拿不到就让用户手填，不假装有）
	@Published public var availableModels: [(id: String, note: String)] = []
	@Published public var modelsNote: String?
	/// 这份清单从哪儿来的：provider-api（实时问服务商）/ pi-catalog（pi 自带目录，可能过时）
	@Published public var modelsSource: String?
	@Published public var loadingModels = false

	public func loadModels(provider: String) {
		guard !provider.isEmpty else { return }
		loadingModels = true
		modelsNote = nil
		requestInBackground(
			["id": UUID().uuidString, "type": "query.models", "provider": provider, "protocolVersion": protocolVersion],
			client: client
		) { [self] response, failure in
			loadingModels = false
			guard let object = response?.objectValue else {
				availableModels = []
				modelsNote = "列不出模型（可以手填）：\(failure ?? "内核没有回应")"
				return
			}
			let list = object["models"]?.arrayValue?.compactMap { item -> (id: String, note: String)? in
				guard let entry = item.objectValue, let id = entry["id"]?.stringValue else { return nil }
				return (id: id, note: entry["note"]?.stringValue ?? "")
			} ?? []
			let source = object["source"]?.stringValue ?? "pi-catalog"
			let endpoint = object["endpoint"]?.stringValue
			let fallback = object["fallbackReason"]?.stringValue
			availableModels = list
			modelsSource = source
			// 来源必须说清楚：是**实时问服务商**，还是 pi 自带的旧目录
			if source == "provider-api" {
				modelsNote = "实时来自 \(endpoint ?? "服务商")　·　共 \(list.count) 个"
			} else if !list.isEmpty {
				modelsNote = "⚠︎ 这不是实时清单：来自 pi 自带的模型目录（可能过时）\(fallback.map { "——" + $0 } ?? "")。可以手填模型名。"
			} else {
				modelsNote = "没列出来（\(fallback ?? "未知原因")）——直接手填模型名"
			}
		}
	}

	/// 拉一次设置（**解析在主线程**：响应是非 Sendable 的 JSON 值，不能漏到后台）。
	public func loadSettings() {
		requestInBackground(["id": UUID().uuidString, "type": "query.settings", "protocolVersion": protocolVersion], client: client) { [self] response, _ in
			// 解码规则在契约镜像里（SpriteRPC/KernelSettings），有独立单测
			settings = KernelSettings.decode(response)
		}
	}

	/// 保存设置。`patch` 直接是内核认识的形状（model / quietHours / proactive）。
	public func saveSettings(_ patch: [String: Any], completion: (@MainActor @Sendable (Bool) -> Void)? = nil) {
		guard let client else {
			settingsNote = "没连上内核，设置没有保存"
			completion?(false)
			return
		}
		settingsSaving = true
		requestInBackground(
			[
				"id": UUID().uuidString,
				"type": "command",
				"command": ["id": UUID().uuidString, "type": "settings.update", "patch": patch, "source": "ui"],
				"protocolVersion": protocolVersion,
			],
			client: client
		) { [self] response, failure in
			settingsSaving = false
			guard let object = response?.objectValue else {
				settingsNote = "保存失败：\(failure ?? "内核没有回应")"
				completion?(false)
				return
			}
			// 把"到底存成了什么"原样列出来：用户一眼能看出有没有存错（设置这种东西不许含糊）
			var parts = ["已保存"]
			let describe = object["describe"]?.stringValue ?? ""
			if !describe.isEmpty { parts.append(describe) }
			if let quiet = object["quietHours"]?.objectValue {
				let start = int(quiet["start"]) ?? 0
				let end = int(quiet["end"]) ?? 0
				parts.append(String(format: "安静 %02d:00–%02d:00", start, end))
			}
			if let proactive = object["proactive"]?.objectValue {
				let perDay = int(proactive["perDay"]) ?? 0
				let enabled = proactive["enabled"]?.boolValue ?? true
				parts.append(enabled ? "主动 ≤\(perDay) 次/天" : "不主动说话")
			}
			if object["piRestarted"]?.boolValue == true {
				let available = object["piAvailable"]?.boolValue ?? false
				parts.append(available ? "思考引擎已按新模型重启" : "模型已换，但引擎没能起来（检查密钥/地址）")
			} else if object["modelChanged"]?.boolValue == false {
				parts.append("模型没变，引擎没重启")
			}
			settingsNote = parts.joined(separator: "　·　")
			loadSettings()
			completion?(true)
		}
	}

	/// 最近一段语音在记忆里的文件（内核返回的，不是本地路径）
	@Published public var lastVoiceFile: String?
	/// 这一段录音的"完整体检"结论（时长/字数/通道/是否可能漏话）
	@Published public var voiceSummary: String?

	/// 识别通道：true = 系统通道（更准，**音频会送到 Apple**）；false = 设备端（语音不出这台机器）。
	///
	/// 默认是**系统通道**，这是被实测逼出来的：这台机器上的设备端中文识别会静默截断——
	/// 1 分 43 秒的录音只吐出结尾 20 字，切成 25 秒的块有些块直接空，同一段音频系统通道 161 字完整。
	/// 用哪条通道是用户的决定，所以界面上有一个开关，并且写明代价。
	@Published public var useSystemRecognition: Bool {
		didSet {
			UserDefaults.standard.set(useSystemRecognition, forKey: Self.systemRecognitionKey)
			onRecognitionChannelChange?(useSystemRecognition)
		}
	}
	public static let systemRecognitionKey = "sprite.useSystemRecognition"
	/// 通道变了要通知录音服务
	public var onRecognitionChannelChange: ((Bool) -> Void)?

	/// 转写看起来**不完整**：字数明显撑不起这段时长。
	///
	/// 中文口语大约每秒 3–5 字，这里用非常宽松的 1.2 字/秒——宁可偶尔误报，
	/// 也不能让你把一段缺了八成的话发出去（真实事故：1 分 43 秒只转出 20 字就发出去了）。
	public static func looksIncomplete(text: String, seconds: Double, speakingSeconds: Double? = nil) -> Bool {
		// 有电平数据时用**说话时长**判定：录音里的沉默不算"该转出字的时间"。
		// 旧实现只看总时长，于是"15 秒里说了 10 个字"（中间有停顿）会被误报成不完整——
		// 那条提示在真实使用里几乎每次录音都出现（用户反馈："这个录音报错一直存在"）。
		if let speaking = speakingSeconds, speaking >= 1.0 {
			let characters = Double(text.trimmingCharacters(in: .whitespacesAndNewlines).count)
			return characters < speaking * 1.5
		}
		guard seconds >= 8 else { return false }
		return Double(text.trimmingCharacters(in: .whitespacesAndNewlines).count) < seconds * 1.2
	}

	/// 刚录的这一段没听出文字——界面上要给一条"再试一次"的路，而不是默默什么都没有
	@Published public var voiceNeedsRetry = false
	/// 重新转写的进度/结果（如实说用了哪条通道）
	@Published public var retranscribeNote: String?
	@Published public var retranscribing = false
	private let transcriber = VoiceTranscriber()
	private var recognitionChannel: VoiceTranscriber.Channel { useSystemRecognition ? .system : .onDevice }
	/// 正在播放的语音（记录窗口用）
	@Published public var playingPath: String?

	private var audioPlayer: AVAudioPlayer?



	/// 转写结果 → 输入框（追加，不覆盖用户已经打的字）
	public func appendTranscript(_ text: String) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		// 同一段转写可能到达两次（onVoiceNote 与 onTranscript 是两条回调；
		// 识别任务重启时也会重发）。整句一模一样地贴着再来一遍，是重复投递，
		// 不是用户又说了一遍——自检抓到的真 bug：输入框里出现"话 话"。
		if draft == trimmed || draft.hasSuffix(trimmed) { return }
		if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			draft = trimmed
		} else {
			draft += (draft.hasSuffix(" ") ? "" : " ") + trimmed
		}
		pendingTranscript = trimmed
	}

	/// 把一段语音（音频 + 转写）交给内核存进记忆。
	///
	/// 顺序很重要：**先存再显示**。用户在面板上看到"已存"时，音频已经落在记忆里了；
	/// 面板被关掉、程序退出都不会让它消失。
	public func commitVoice(transcript: String, audioURL: URL?, durationMs: Int, completion: (@MainActor @Sendable (Bool) -> Void)? = nil) {
		// 音频文件的读取是磁盘 I/O，放在后台（几十 KB 到几百 KB，但在主线程读会卡界面）
		let audioURLBox = Immutable(audioURL)
		DispatchQueue.global(qos: .userInitiated).async { [self] in
			var payload: [String: Any] = [
				"id": UUID().uuidString,
				"type": "voice.commit",
				"transcript": transcript,
				"durationMs": durationMs,
				"mimeType": audioURLBox.value?.pathExtension.lowercased() == "caf" ? "audio/x-caf" : "audio/mp4",
			]
			if let url = audioURLBox.value, let data = try? Data(contentsOf: url) {
				payload["audioBase64"] = data.base64EncodedString()
			}
			let payloadBox = Immutable(payload)
			onMain { [self] in
				requestInBackground(["id": UUID().uuidString, "type": "command", "command": payloadBox.value, "protocolVersion": protocolVersion], client: client) { [self] response, failure in
					guard let object = response?.objectValue else {
						archiveNote = "语音没能存进记忆：\(failure ?? "内核没有回应")"
						completion?(false)
						return
					}
					let file = object["file"]?.stringValue
					let bytes = int(object["bytes"]).map { max(1, $0 / 1024) }
					let size = bytes.map { "\($0) KB" }
					archiveNote = [file != nil ? "语音已存进记忆" : "只存了文字（没有音频）", size].compactMap { $0 }.joined(separator: "　·　")
					lastVoiceFile = file
					voiceNeedsRetry = file != nil && transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
					recordsRevision += 1
					completion?(true)
				}
			}
		}
	}

	/// 对一段已存的语音重新转写，并把结果补写回内核。
	///
	/// `allowSystem: true` 表示允许走系统识别通道（音频会送到 Apple）——
	/// 这个决定只能由用户点按钮做出，代码不替他做主。
	public func retranscribe(path: String, forceChannel: VoiceTranscriber.Channel? = nil) {
		guard !retranscribing else { return }
		retranscribing = true
		retranscribeNote = "正在取回音频…"
		loadAudio(path: path) { [weak self] data in
			guard let self else { return }
			guard let data, !data.isEmpty else {
				self.retranscribing = false
				self.retranscribeNote = "⚠︎ 读不到这段录音"
				return
			}
			let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("retry-" + (path as NSString).lastPathComponent)
			try? data.write(to: tmp)
			let level = VoiceTranscriber.levelSummary(url: tmp).map { "（\($0)）" } ?? ""
			self.retranscribeNote = "正在重新识别\(level)…"
			// 通道 = 设置里的那条（用户已经就"音频出不出机器"做过选择）；
			// 点"换通道再试"时显式指定另一条。
			let channel = forceChannel ?? self.recognitionChannel
			self.transcriber.transcribe(url: tmp, channel: channel) { outcome in
				self.retranscribing = false
				guard outcome.ok else {
					self.retranscribeNote = "⚠︎ " + outcome.channel
					return
				}
				self.retranscribeNote = "识别完成（\(outcome.channel)），正在写回记忆…"
				self.submitTranscript(file: path, transcript: outcome.text) { ok, problem in
					if ok {
						self.retranscribeNote = "已补写转写（\(outcome.channel)）"
						self.voiceNeedsRetry = false
						self.appendTranscript(outcome.text)
						self.recordsRevision += 1
					} else {
						self.retranscribeNote = "⚠︎ 识别出来了但写不回记忆：\(problem ?? "内核没有回应")"
					}
				}
			}
		}
	}

	/// 请内核把转写补写到某段语音上（外壳不直接改记忆）
	/// 请内核把转写补写到某段语音上（外壳不直接改记忆）
	private func submitTranscript(file: String, transcript: String, completion: @escaping @MainActor @Sendable (Bool, String?) -> Void) {
		requestInBackground(
			["id": UUID().uuidString, "type": "command", "command": ["id": UUID().uuidString, "type": "voice.transcript", "file": file, "transcript": transcript], "protocolVersion": protocolVersion],
			client: client
		) { _, failure in
			completion(failure == nil, failure)
		}
	}

	/// 记录窗口刷新信号（存了一条语音就 +1，界面据此重拉列表）
	@Published public var recordsRevision = 0

	/// 播放一段存在记忆里的录音（音频由内核读出，外壳不碰记忆目录）
	public func playAudio(path: String, completion: (@MainActor @Sendable (String?) -> Void)? = nil) {
		if playingPath == path, let player = audioPlayer, player.isPlaying {
			stopAudio()
			completion?(nil)
			return
		}
		loadAudio(path: path) { [weak self] data in
			guard let self else { return }
			guard let data, !data.isEmpty else {
				completion?("读不到这段录音")
				return
			}
			do {
				let player = try AVAudioPlayer(data: data)
				player.prepareToPlay()
				guard player.play() else {
					completion?("这段录音播不出来")
					return
				}
				self.audioPlayer = player
				self.playingPath = path
				completion?(nil)
				// 播完把状态清掉，按钮回到"播放"
				DispatchQueue.main.asyncAfter(deadline: .now() + player.duration + 0.2) {
					if self.playingPath == path { self.playingPath = nil }
				}
			} catch {
				completion?("这段录音播不出来：\(error.localizedDescription)")
			}
		}
	}

	public func stopAudio() {
		audioPlayer?.stop()
		audioPlayer = nil
		playingPath = nil
	}

	/// 读一段录音的字节（内部走 RPC，不读文件系统）
	public func loadAudio(path: String, completion: @escaping @MainActor @Sendable (Data?) -> Void) {
		requestInBackground(["id": UUID().uuidString, "type": "query.audio", "path": path, "protocolVersion": protocolVersion], client: client) { response, _ in
			let base64 = response?.objectValue?["base64"]?.stringValue
			completion(base64.flatMap { Data(base64Encoded: $0) })
		}
	}

	/// 拉一批记录（对话 / 思维流 / 日记 / 探索笔记）——只读，由内核交出
	public func loadRecords(kind: String, limit: Int = 60, attempt: Int = 0, completion: @escaping @MainActor @Sendable ([[String: String]]) -> Void) {
		guard client != nil, connected else {
			// 真实用户反馈："思维流空了"。原因就是这个 return：面板刚开、
			// 内核还没连上时悄悄返回空列表，而且**再也不重试**——界面就永远空着。
			// 现在：没连上就等一会儿再来，直到连上为止。
			guard attempt < 20, !stopped else { completion([]); return }
			mainAsyncAfter(.now() + 0.5) { [self] in
				loadRecords(kind: kind, limit: limit, attempt: attempt + 1, completion: completion)
			}
			return
		}
		requestInBackground(["id": UUID().uuidString, "type": "query.records", "kind": kind, "limit": limit, "protocolVersion": protocolVersion], client: client) { [self] response, failure in
			guard let response else {
				recordsError = failure
				// 请求本身失败（内核正忙/刚重启）：等下一拍重来，不要给用户一个假"空"
				guard attempt < 20, !stopped else { completion([]); return }
				mainAsyncAfter(.now() + 0.6) { [self] in
					loadRecords(kind: kind, limit: limit, attempt: attempt + 1, completion: completion)
				}
				return
			}
			var entries: [[String: String]] = []
			if let list = response.objectValue?["entries"]?.arrayValue {
				for item in list {
					guard let object = item.objectValue else { continue }
					var entry: [String: String] = [:]
					for (key, value) in object {
						// 字符串照收；**数字也要收**——count/bytes 这类字段是数字，
						// 之前只取 stringValue，界面上"8 条"永远显示不出来。
						if let text = value.stringValue {
							entry[key] = text
						} else if let number = value.numberValue {
							entry[key] = number == number.rounded() ? String(Int(number)) : String(number)
						} else if let flag = value.boolValue {
							entry[key] = flag ? "true" : "false"
						}
					}
					entries.append(entry)
				}
			}
			recordsError = nil
			completion(entries)
		}
	}

	/// 读一篇记录的正文
	public func loadDocument(path: String, completion: @escaping @MainActor @Sendable (String) -> Void) {
		requestInBackground(["id": UUID().uuidString, "type": "query.document", "path": path, "protocolVersion": protocolVersion], client: client) { response, _ in
			completion(response?.objectValue?["text"]?.stringValue ?? "")
		}
	}
	/// 录音开关（由 AppDelegate 接线）
	public var onToggleRecording: (() -> Void)?
	/// 语音状态文字
	@Published public var voiceStatusText = ""

	/// 录音中
	@Published public var isRecording = false
	/// 录音阶段："idle" / "recording" / "transcribing"——浮层据此显示
	@Published public var voicePhase = "idle"
	/// 已录时长（mm:ss，每秒刷新）
	@Published public var recordingElapsed = "0:00"
	/// 实时听到的内容（让人看见它在听）
	@Published public var recordingLiveText = ""

	/// 诊断信息（可选中复制）
	public var diagnosticsText: String {
		var lines: [String] = []
		lines.append("socket：\(socketPath)")
		lines.append("连接：\(connected ? "已连接" : "未连接")")
		lines.append("事件：\(eventCount) 条　末尾 seq=\(lastEventSeq)")
		if let state {
			lines.append("待处理留言：\(state.pendingCount)")
			lines.append("工具决策：\(state.toolDecisions)")
			if !state.failures.isEmpty { lines.append("失败：\(state.failures.suffix(2).joined(separator: " / "))") }
			if !state.problems.isEmpty { lines.append("问题：\(state.problems.suffix(2).joined(separator: " / "))") }
		}
		return lines.joined(separator: "\n")
	}
	public var onBubble: ((String) -> Void)?
	/// 它有问题要问的时候：外壳把它显示出来（不阻塞它的运行）
	public var onQuestion: ((String, [String]) -> Void)?
	/// 每一条事件（诊断/无界面模式用）
	public var onEvent: ((SpriteEvent) -> Void)?
	/// 收到的事件条数（无界面模式用来判断链路是否真的通了）
	public private(set) var eventCount = 0

	private var client: CoreClient?
	private let socketPath: String
	private var statusRefreshScheduled = false
	private var reconnectAttempts = 0
	private var reconnectScheduled = false
	private var stopped = false
	/// 连接状态变化（true=连上，false=断开并附带原因）：界面据此如实告知，而不是假装一切正常
	public var onConnectionChange: ((Bool, String?) -> Void)?

	public init(socketPath: String) {
		self.socketPath = socketPath
		// @Published 的 didSet 在初始化期间不触发，这里直接读，避免"每次启动都写一遍设置"
		self.useSystemRecognition = UserDefaults.standard.object(forKey: Self.systemRecognitionKey) == nil
			? true
			: UserDefaults.standard.bool(forKey: Self.systemRecognitionKey)
	}

	public func start() {
		connect(isFirstAttempt: true)
	}

	/// 连接（或重连）内核。
	///
	/// 重连语义：**先拉一次快照再用它的 seq 订阅** —— 内核可能已经重启过，
	/// 期间发生的事件必须靠快照校准，而不是假设"接着上次的 seq 就行"。
	/// 否则界面会显示一个已经不存在了的旧世界。
	private func connect(isFirstAttempt: Bool) {
		// 连接与快照都是**阻塞 I/O**（内核偶尔要等模型），而且重连会反复触发。
		// 老实现在主线程做这些：断线时界面会一遍遍冻住（评审 M9）。
		// 现在整个 I/O 过程在后台队列上跑，只有状态变更回主线程。
		let wasStopped = stopped
		let socketPath = socketPath
		DispatchQueue.global(qos: .userInitiated).async { [self] in
			guard !wasStopped else { return }
			do {
				let client = try CoreClient(socketPath: socketPath)
				// 快照不是 Sendable → 装箱带回主线程
				let snapshotBox = Immutable(try client.snapshot())
				let snapshot = snapshotBox.value
				// 订阅回调在后台 reader 线程上触发 → 一律回主线程再动状态
				try client.subscribe(fromSeq: snapshot.seq, onEvent: { [self] event in
					onMain { self.apply(event) }
				}, onError: { [self] error in
					onMain { self.handleDisconnect(error) }
				})
				onMain {
					guard !self.stopped else { return }
					self.client = client
					self.connected = true
					self.connectionError = nil
					self.reconnectAttempts = 0
					self.snapshot = snapshot
					self.state = snapshot.state
					self.lastEventSeq = snapshot.seq
					self.reconcileOptimisticEchoes()
					self.nextBreathAt = snapshot.state.nextBreathAt.flatMap(Self.parse)
					self.onConnectionChange?(true, nil)
					self.onChange?()
				}
			} catch {
				onMain {
					guard !self.stopped else { return }
					self.connected = false
					self.connectionError = "\(error)"
					self.onConnectionChange?(false, "\(error)")
					self.onChange?()
					self.scheduleReconnect(isFirstAttempt: isFirstAttempt)
				}
			}
		}
	}

	private func handleDisconnect(_ error: Error) {
		connected = false
		connectionError = "\(error)"
		client?.close()
		client = nil
		onConnectionChange?(false, "\(error)")
		onChange?()
		scheduleReconnect()
	}

	/// 延迟到主队列执行（等价于 `DispatchQueue.main.asyncAfter` + main-actor 隔离）
	private func mainAsyncAfter(_ deadline: DispatchTime, _ work: @escaping @MainActor () -> Void) {
		DispatchQueue.main.asyncAfter(deadline: deadline) {
			MainActor.assumeIsolated { work() }
		}
	}

	/// 退避重连：1s → 2s → 4s → … 最多 30s。内核重启是常态（升级、崩溃恢复），
	/// 外壳不能因此永久失效——它必须自己走回去。
	private func scheduleReconnect(isFirstAttempt: Bool = false) {
		guard !stopped else { return }
		reconnectAttempts += 1
		let delay = min(30.0, pow(2.0, Double(reconnectAttempts - 1)))
		reconnectScheduled = true
		DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
			guard let self, !self.stopped else { return }
			self.reconnectScheduled = false
			self.connect(isFirstAttempt: false)
		}
	}

	public func stop() {
		stopped = true
		subscriptionCancel()
		client?.close()
		client = nil
	}

	private func subscriptionCancel() {
		// CoreClient.close() 会取消订阅
	}

	// MARK: - 用户动作（全部走命令，幂等键由外壳生成）

	/// 发送一句话。返回 false 表示**没发出去**（调用方必须把内容还给用户，不能悄悄吞掉）。
	@discardableResult
	public func sendMessage(_ text: String) -> Bool {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return false }
		guard let client else {
			// 曾经这里直接 return —— 用户以为发出去了，其实什么都没发生。
			connectionError = "内核没连上，这句话没有发出去（内容已留在输入框）"
			onChange?()
			return false
		}

		// 先本地乐观显示：点下发送就该立刻看到，而不是等内核回事件
		optimisticIncoming.append(trimmed)
		onChange?()

		// 阻塞式 RPC 放到后台：内核偶尔繁忙（例如它正在跑模型的 RPC），
		// 在主线程序列化等待会让界面直接冻住（评审 M9）
		// 结果放进不可变箱子：后台闭包只写一次，主线程读一次（不需要锁，也不给编译器留把柄）
		let sent = DispatchSemaphore(value: 0)
		let failureBox = ResultBox()
		DispatchQueue.global(qos: .userInitiated).async {
			do {
				_ = try client.sendMessage(text: trimmed)
			} catch {
				failureBox.set(String(describing: error))
			}
			sent.signal()
		}
		// 最多等 1 秒：等不到就当作"已发出"，由事件流来确认（乐观回显已经显示）
		if sent.wait(timeout: .now() + 1.0) == .timedOut {
			connectionError = nil
			return true
		}
		if let failure = failureBox.value {
			optimisticIncoming.removeAll { $0 == trimmed }
			connectionError = "发送失败：\(failure)（内容已留在输入框）"
			onChange?()
			return false
		}
		connectionError = nil
		return true
	}

	/// 已发送但内核还没回件的本地回显（内核事件到达后自动清掉）
	private var optimisticIncoming: [String] = []

	/// 快照刷新/重连时清掉乐观回显：新状态里已经有真实的那条了，
	/// 留着会永久显示"你（发送中）"，而且和快照里的同一条**重复**。
	private func reconcileOptimisticEchoes() {
		guard !optimisticIncoming.isEmpty, let state else { return }
		optimisticIncoming.removeAll { text in
			state.messages.contains { $0.text == text }
		}
	}

	/// 最近一次"叫醒"的结果（如实显示，过期自动消失）
	public private(set) var wakeNotice: String?
	private var wakeNoticeUntil: Date?

	private func setWakeNotice(_ text: String, seconds: Double) {
		wakeNotice = text
		wakeNoticeUntil = Date().addingTimeInterval(seconds)
		onChange?()
	}

	/// 叫醒它。**必须把结果显示出来**——内核已经如实回了"已叫醒/已延后"，
	/// 早先外壳把这个返回值丢掉了，于是用户点了按钮却看不出发生了什么。
	public func wakeNow() {
		guard let client else {
			setWakeNotice("内核没连上，叫不醒它", seconds: 8)
			return
		}
		setWakeNotice("正在叫醒它…", seconds: 10)
		// 同样放后台：这一条要等内核排好下一拍才回，阻塞主线程就是界面卡住
		DispatchQueue.global(qos: .userInitiated).async { [self] in
			do {
				let result = try client.wakeNow()
				let deferred = result.objectValue?["deferred"] == .bool(true)
				let overrode = result.objectValue?["overrodeQuiet"] == .bool(true)
				onMain {
					if deferred {
						self.setWakeNotice("它现在不方便（安静时段）——你的话会在它下次醒来时看到", seconds: 20)
					} else if overrode {
						self.setWakeNotice("已经叫醒它了（安静时段，按你的要求越过）", seconds: 12)
					} else {
						self.setWakeNotice("已经叫醒它了，它正在醒来", seconds: 12)
					}
				}
			} catch {
				onMain { self.setWakeNotice("叫醒失败：\(error)", seconds: 15) }
			}
		}
	}

	/// 暂停 / 继续：同样是阻塞 RPC，放后台（评审 M9：在主线程序列化等待会让面板卡住）
	private func runPauseCommand(_ label: String, _ work: @escaping @Sendable (CoreClient) throws -> Void) {
		guard let client else { return }
		DispatchQueue.global(qos: .userInitiated).async { [self] in
			do {
				try work(client)
			} catch {
				onMain {
					self.connectionError = "\(label)失败: \(error)"
					self.onChange?()
				}
			}
		}
	}

	public func pause(until: String) {
		runPauseCommand("暂停") { client in _ = try client.pause(until: until) }
	}

	public func resume() {
		runPauseCommand("继续") { client in _ = try client.resume() }
	}

	public var isPaused: Bool { state?.presence == .paused }

	/// 自检用：注入一个状态
	public func applyForTest(_ state: KernelState) {
		self.state = state
		self.snapshot = nil
	}

	/// 面板里"这次运行"要显示的内容：内核确认过的 + 还没确认的本地回显
	public var conversationSinceLaunch: [(speaker: String, text: String)] {
		var entries: [(String, String, Int)] = []
		if let state {
			entries += state.messages.filter { $0.imported != true }.map { ("你", $0.text, $0.seq) }
			entries += state.outgoing.filter { $0.imported != true }.map { ("它", $0.text, $0.seq + 1) }
		}
		// 还没被内核确认的排在最**后**（最新的话在最下面），用大序号保证顺序稳定
		entries += optimisticIncoming.enumerated().map { ("你（发送中）", $0.element, Int.max - 1000 + $0.offset) }
		return entries.sorted { $0.2 < $1.2 }.map { (speaker: $0.0, text: $0.1) }
	}

	/// 立刻重新拉一次快照与读模型（设置面板的"重新检测"用）。
	/// 不重连、不改订阅——只是把最新事实取回来。
	public func refreshNow() {
		guard let client else { return }
		DispatchQueue.global(qos: .userInitiated).async {
			// 两个响应都不是 Sendable：装箱（不可变快照）带回主线程
			let snapshotBox = Immutable(try? client.snapshot())
			let statusBox = Immutable(try? client.status())
			onMain { [self] in
				if let snapshot = snapshotBox.value {
					self.snapshot = snapshot
					self.lastEventSeq = max(self.lastEventSeq, snapshot.seq)
				}
				if let status = statusBox.value { self.state = status }
				self.onChange?()
			}
		}
	}

	// MARK: - 事件折叠

	private func apply(_ event: SpriteEvent) {
		eventCount += 1
		lastEventSeq = max(lastEventSeq, event.seq)
		onEvent?(event)
		switch SpriteEvent.KnownEventType(rawValue: event.type) {
		case .presenceChanged:
			if let raw = event.data["state"]?.stringValue, let presence = PresenceState(rawValue: raw) {
				state = state?.withPresence(presence)
			}
		case .breathScheduled:
			if let iso = event.data["nextBreathAt"]?.stringValue { nextBreathAt = Self.parse(iso) }
			if let ms = event.data["intervalMs"]?.numberValue { intervalMs = ms }
		case .messageOut:
			if let text = event.data["text"]?.stringValue, event.data["channel"]?.stringValue == "bubble" {
				onBubble?(text)
				onSpeechRequest?(text)
			}
		case .messageIn:
			if let text = event.data["text"]?.stringValue, let current = state {
				state = current.appendingIncoming(text: text, seq: event.seq, at: event.at)
				optimisticIncoming.removeAll { $0 == text }
			}
		case .thoughtRecorded:
			if let text = event.data["text"]?.stringValue, let current = state {
				state = current.appendingThought(text)
			}
		case .runActivity:
			if let current = state {
				state = current.appendingActivity(RunActivity(
					kind: event.data["kind"]?.stringValue ?? "activity",
					tool: event.data["tool"]?.stringValue,
					summary: event.data["summary"]?.stringValue,
					seq: event.seq,
					at: event.at
				))
			}
		case .systemProblem:
			if let current = state, let message = event.data["userMessage"]?.stringValue {
				state = current.appendingProblem(message)
			}
		case .wakeDeferred:
			// 内核如实记了"延后"，外壳也必须如实告诉人
			let reason = event.data["reason"]?.stringValue ?? "现在不方便"
			setWakeNotice("它没有立刻醒来：\(reason)", seconds: 20)
		case .runStarted:
			wakeNotice = nil
			wakeNoticeUntil = nil
		case .questionAsked:
			if let current = state, let question = event.data["question"]?.stringValue {
				let options = event.data["options"]?.arrayValue?.compactMap { $0.stringValue } ?? []
				state = current.appendingQuestion(PendingQuestion(question: question, options: options, seq: event.seq, at: event.at))
				onQuestion?(question, options)
			}
		default:
			break // 未知事件类型：忽略而不是崩溃（前向兼容）
		}
		// 计数器类字段（runs / toolDecisions / deferrals / failures…）不在外壳里重算：
		// 读模型由内核组装，外壳回头问一次。防抖是为了让一次呼吸的十几条事件只触发一次刷新。
		scheduleStatusRefresh()
		objectWillChange.send()
		onChange?()
	}

	/// 从内核重新拉一次读模型。
	///
	/// 为什么不在 Swift 里做增量推导：那等于把内核的推导逻辑抄一遍，两边一定会漂移。
	/// 这个 bug 真实发生过——外壳显示的"呼吸次数"永远是 0，而事件流里明明有 run。
	private func scheduleStatusRefresh() {
		guard !statusRefreshScheduled else { return }
		statusRefreshScheduled = true
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
			guard let self else { return }
			self.statusRefreshScheduled = false
			guard let client = self.client else { return }
			// 阻塞调用放到后台队列：内核偶尔繁忙时不能把界面冻住
			DispatchQueue.global(qos: .utility).async {
				let freshBox = Immutable(try? client.status())
				onMain { [self] in
					guard let fresh = freshBox.value else { return }
					self.state = fresh
					self.onChange?()
				}
			}
		}
	}

	// MARK: - 界面用的派生值

	/// 光球脉动周期（秒）。
	///
	/// 真实间隔可能是 5 分钟，逐字照搬会看不见动；这里用一个**单调**映射压缩它：
	/// 节奏越快，光越快。数字本身在面板上如实显示，视觉只是它的可感知投影。
	public var orbPulsePeriod: Double {
		guard let intervalMs else { return state?.presence == .quiet ? 8.0 : 4.0 }
		let minutes = max(0.5, intervalMs / 60_000)
		return min(8.0, max(1.2, 1.2 + log2(minutes) * 1.6))
	}

	/// 距离下次醒来的秒数（显示层每秒刷新）
	public var secondsUntilNextBreath: Int? {
		guard let nextBreathAt else { return nil }
		return max(0, Int(nextBreathAt.timeIntervalSinceNow.rounded()))
	}

	/// 这一拍已经走完的比例（0…1）。呼吸环用它，所以环走满的时刻 == 内核说的醒来时刻。
	public var breathProgress: Double {
		guard let nextBreathAt, let intervalMs, intervalMs > 0 else { return 0 }
		let elapsed = intervalMs / 1000 - nextBreathAt.timeIntervalSinceNow
		return min(1, max(0, elapsed / (intervalMs / 1000)))
	}

	public var presenceTitle: String {
		// 断线时不许显示上一次的旧状态：那是在撒谎。内核不在，就说内核不在。
		guard connected else { return "没有连上内核" }
		switch state?.presence {
		case .asleep: return "它睡着了"
		case .breathing: return "它在呼吸"
		case .thinking: return "它在想事情"
		case .quiet: return "它在休息"
		case .paused: return "你让它安静一会儿"
		case .degraded: return "它不舒服"
		case nil: return "正在读取它的状态"
		}
	}

	/// 它今天做了什么（内核数的，外壳不猜）：面板与记录窗口显示同一份
	public var todaySummary: String? { state?.today?.summary }

	/// 连续空转的提示：它醒着却一直没做事——用户看得出来，不用靠"它说没说话"猜
	public var idleHint: String? {
		guard let streak = state?.idleStreak, streak >= 5 else { return nil }
		return "它连续 \(streak) 次醒来都没做事"
	}

	/// 待处理留言（安静时段/暂停时排队的那些）
	public var pendingCount: Int { state?.pendingMessages.count ?? 0 }

	/// 给用户看的一句话：它现在为什么没回你、什么时候会回
	public var quietNotice: String? {
		guard let state else { return nil }
		guard state.presence == .quiet || state.presence == .paused else { return nil }
		var parts: [String] = []
		if state.presence == .quiet { parts.append("安静时段（23:00–07:00）它不出声") }
		if state.presence == .paused { parts.append("你让它安静一会儿") }
		if pendingCount > 0 { parts.append("你发的 \(pendingCount) 条已经存下了，它醒来就看到——想现在说就点「现在叫醒它」") }
		return parts.joined(separator: "　·　")
	}

	public var activityText: String? {
		guard let activity = state?.activities.last else { return nil }
		switch activity.tool {
		case "read": return "正在读东西"
		case "bash": return "正在动手做事"
		case "write", "edit": return "正在写东西"
		case "say": return "正在斟酌措辞"
		case .some(let tool): return "正在用 \(tool)"
		case nil: return "正在做事"
		}
	}

	public var nextBreathText: String {
		guard connected else { return "内核未运行" }
		guard let seconds = secondsUntilNextBreath else { return "还没有安排下一次" }
		if seconds <= 0 { return "该醒来了" }
		if seconds < 60 { return "大约 \(seconds) 秒后醒来" }
		return "大约 \(seconds / 60) 分钟后醒来"
	}

	/// 面板底部那一行：有叫醒结果就先说结果（并说明它此刻在干什么），否则显示倒计时。
	public var breathLine: String {
		if let wakeNotice, let until = wakeNoticeUntil, Date() < until {
			return wakeNotice + "\n" + currentActivityLine
		}
		if state?.presence == .thinking { return "它现在醒着（正在做事）\n" + nextBreathText }
		return nextBreathText
	}

	private var currentActivityLine: String {
		switch state?.presence {
		case .thinking: return "它现在醒着，正在做事"
		case .breathing: return "它醒着，等下一次呼吸"
		case .quiet: return "它在休息（安静时段）"
		case .paused: return "你已经让它安静下来"
		case .degraded: return "它现在不舒服（看诊断）"
		default: return "它现在不在呼吸"
		}
	}

	public static func parse(_ iso: String) -> Date? {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let date = formatter.date(from: iso) { return date }
		formatter.formatOptions = [.withInternetDateTime]
		return formatter.date(from: iso)
	}
}

// MARK: - 不可变的状态更新辅助（避免外壳改写出内核没说过的东西）

extension KernelState {
	/// 只替换部分字段的辅助：内核没说过的东西绝不自造。
	private func copy(
		presence: PresenceState? = nil,
		thoughts: [String]? = nil,
		activities: [RunActivity]? = nil,
		questions: [PendingQuestion]? = nil,
		messages: [IncomingMessage]? = nil,
		problems: [String]? = nil
	) -> KernelState {
		KernelState(
			presence: presence ?? self.presence,
			nextBreathAt: nextBreathAt,
			messages: messages ?? self.messages,
			pendingMessages: pendingMessages,
			outgoing: outgoing,
			thoughts: thoughts ?? self.thoughts,
			activities: activities ?? self.activities,
			questions: questions ?? self.questions,
			toolDecisions: toolDecisions,
			deferrals: deferrals,
			runs: runs,
			danglingRun: danglingRun,
			failures: failures,
			problems: problems ?? self.problems,
			// 漏了这个字段 → 每折叠一条事件名字就被抹成 nil，面板里的名字会闪回"它"
			companionName: companionName
		)
	}

	func withPresence(_ presence: PresenceState) -> KernelState {
		copy(presence: presence)
	}

	func appendingIncoming(text: String, seq: Int, at: String) -> KernelState {
		copy(messages: messages + [IncomingMessage(text: text, source: "text", seq: seq, at: at, imported: false)])
	}

	func appendingThought(_ text: String) -> KernelState {
		copy(thoughts: thoughts + [text])
	}

	func appendingActivity(_ activity: RunActivity) -> KernelState {
		copy(activities: activities + [activity])
	}

	func appendingQuestion(_ question: PendingQuestion) -> KernelState {
		copy(questions: questions + [question])
	}

	func appendingProblem(_ message: String) -> KernelState {
		copy(problems: problems + [message])
	}
}
