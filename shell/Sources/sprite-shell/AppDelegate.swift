import AppKit
import SpriteRPC
import SwiftUI

/// 应用装配：菜单栏图标 + 下拉面板 + 记录窗口 + 语音。
///
/// v3 第二轮交互重做（真实用户反馈驱动）：
///   · **删掉桌面光球**——"不新鲜，也不是原始设定"；交互面就是菜单栏
///   · **菜单栏下拉是主要交互面**：看状态、看它刚说的、说一句、快动作
///   · **图标本身会呼吸**：按它真实的呼吸间隔缓慢明暗，扫一眼就知道它在不在
///   · **⌥K 随手说话**（Carbon 热键，不需要辅助功能权限）
///   · 记录窗口是**展示工具**：翻日记 / 笔记 / 对话，不是对话入口
/// 主线程隔离：它管着状态栏图标、popover、面板、定时器——全是 UI，
/// 本来就只该在主线程动。Swift 6 下由编译器守着这件事。
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
	private let socketPath: String
	private let model: ShellModel
	private let speech = SpeechService()
	private let dictation = DictationService()
	private lazy var recorder = RecorderPanelController(model: model)
	private lazy var setupPanel: SetupPanel = {
		let panel = SetupPanel(model: model)
		panel.onRecheck = { [weak self] in self?.model.refreshNow() }
		panel.onOpenConfigFolder = { [weak self] in
			guard let self, let setup = self.model.snapshot?.setup else { return }
			NSWorkspace.shared.open(URL(fileURLWithPath: setup.homeDir))
		}
		panel.onSpeakFirstWords = { [weak self] in self?.togglePopover(focusInput: true) }
		return panel
	}()

	private var statusItem: NSStatusItem?
	private var popover: NSPopover?
	private var recordsWindow: NSWindow?
	/// 记录窗口的「现在」是否正开着（开着就不弹卡片）
	private var recordsShowingLive = false
	/// 首次运行的配置面板是否已经自动弹过
	private var setupPrompted = false
	private let speakingCard = SpeakingCard()
	private var breathTimer: Timer?
	private var iconPhase: Double = 0

	public init(socketPath: String) {
		self.socketPath = socketPath
		self.model = ShellModel(socketPath: socketPath)
		super.init()
	}

	public func applicationDidFinishLaunching(_ notification: Notification) {
		NSApp.setActivationPolicy(.accessory)
		AppDelegate.installEditMenu()

		setupStatusItem()
		setupPopover()
		speakingCard.onReply = { [weak self] in self?.togglePopover(focusInput: true) }
		recorder.onStop = { [weak self] in self?.dictation.stop() }
		recorder.onCancel = { [weak self] in self?.dictation.cancel() }
		wireModel()
		wireDictation()

		// 图标呼吸：0.1 秒一步，周期来自内核的真实节奏
		breathTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [self] _ in
			// Timer 回调在运行循环上触发（本来就是主线程），但它的类型不是 @MainActor：
			// 显式 onMain 说清楚，Swift 6 才认。
			onMain { [self] in
			if self.model.isRecording {
				let text = self.dictation.elapsedText
				if self.model.recordingElapsed != text { self.model.recordingElapsed = text }
			}
			self.model.refreshThinkingClock()
			self.iconPhase += 0.1 / max(1.0, self.model.orbPulsePeriod)
			if self.iconPhase > 1 { self.iconPhase -= 1 }
			self.updateStatusIcon()
			}
		}
		if let breathTimer { RunLoop.main.add(breathTimer, forMode: .common) }

		// ⌥K：随处打开面板说话
		let registered = HotKey.register { [weak self] in self?.togglePopover(focusInput: true) }
		if !registered {
			NSLog("Sprite: 快捷键 %@ 注册失败（可能被其他应用占用）", HotKey.displayName)
		}

		model.start()
		updateStatusIcon()
	}

	public func applicationWillTerminate(_ notification: Notification) {
		breathTimer?.invalidate()
		model.stop()
	}

	// MARK: - 菜单栏

	private func setupStatusItem() {
		let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		item.button?.image = statusIcon(phase: 0)
		item.button?.imagePosition = .imageOnly
		item.button?.title = ""
		item.button?.target = self
		item.button?.action = #selector(handleStatusClick)
		item.button?.sendAction(on: [.leftMouseUp])
		statusItem = item
	}

	/// 图标：一圈细环 + 中心点。环的明暗随真实呼吸节奏变化（"它活着"的唯一视觉信号）。
	private func statusIcon(phase: Double) -> NSImage {
		let size = NSSize(width: 18, height: 18)
		// 录音中：画一个明确的红点（不是"换个颜色"，是真的看得出在录）
		if model.isRecording {
			let image = NSImage(size: size, flipped: false) { _ in
				let pulse = 0.55 + 0.45 * sin(phase * 2 * .pi)
				NSColor.systemRed.withAlphaComponent(pulse).setFill()
				NSBezierPath(ovalIn: NSRect(x: 3, y: 3, width: 12, height: 12)).fill()
				NSColor.white.setFill()
				NSBezierPath(roundedRect: NSRect(x: 7.2, y: 7.2, width: 3.6, height: 3.6), xRadius: 0.8, yRadius: 0.8).fill()
				return true
			}
			image.isTemplate = false
			return image
		}
		let presence = model.state?.presence
		let image = NSImage(size: size, flipped: false) { _ in
			let pulse = 0.5 + 0.5 * sin(phase * 2 * .pi)
			let color: NSColor
			switch presence {
			case .thinking: color = NSColor(calibratedRed: 0.73, green: 0.63, blue: 0.85, alpha: 1)
			case .quiet, .paused: color = NSColor(calibratedWhite: 0.55, alpha: 1)
			case .degraded: color = NSColor(calibratedRed: 0.84, green: 0.72, blue: 0.43, alpha: 1)
			default: color = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
			}
			let ring = NSBezierPath(ovalIn: NSRect(x: 2.5, y: 2.5, width: 13, height: 13))
			ring.lineWidth = 1.2
			color.withAlphaComponent(0.35 + 0.45 * pulse).setStroke()
			ring.stroke()
			let radius = 2.0 + 1.6 * pulse
			let dot = NSBezierPath(ovalIn: NSRect(x: 9 - radius, y: 9 - radius, width: radius * 2, height: radius * 2))
			color.withAlphaComponent(0.55 + 0.45 * pulse).setFill()
			dot.fill()
			return true
		}
		image.isTemplate = false
		return image
	}

	/// 首次运行：模型还没配好就**自动把配置面板端出来**（里面就是那张表）。
	/// 只自动弹一次；用户关掉之后由他自己决定什么时候再来配。
	private func maybeShowSetup() {
		guard !setupPrompted, model.connected, let setup = model.snapshot?.setup else { return }
		guard !setup.hasModelConfig else { return }
		setupPrompted = true
		setupPanel.refresh()
		setupPanel.makeKeyAndOrderFront(nil)
	}

	private func updateStatusIcon() {
		statusItem?.button?.image = statusIcon(phase: iconPhase)
		statusItem?.button?.toolTip = model.isRecording
			? L("正在录音…点这里回来点「停止」")
			: model.presenceTitle + " · " + model.breathLine.replacingOccurrences(of: "\n", with: "　") + L("　（⌥K 跟它说话）")
	}

	@objc private func handleStatusClick() {
		togglePopover(focusInput: false)
	}

	// MARK: - 下拉面板

	private func setupPopover() {
		let popover = NSPopover()
		popover.behavior = .transient
		popover.animates = true
		let controller = NSHostingController(rootView: MenuBarView(model: model))
		// 高度**跟着内容走**：面板自己算内容高度（MenuBarView 里量），
		// 这里让 popover 采纳它。固定 520 的后果是收起诊断后下面空一大块（真实用户反馈）。
		controller.sizingOptions = [.preferredContentSize]
		popover.contentViewController = controller
		self.popover = popover
	}

	private func togglePopover(focusInput: Bool) {
		guard let popover, let button = statusItem?.button else { return }
		if popover.isShown {
			// 开着就关。真实用户反馈：录音时按 ⌥K 面板收不回去，
			// 只能跑去点菜单栏图标——快捷键必须是开关，不是"只能开"。
			popover.performClose(nil)
			return
		}
		model.refreshNow()
		popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
		popover.contentViewController?.view.window?.makeKey()
		// ⌥K 的意图通常是"我要说话"：直接把光标送进输入框，多轮对话不该每次再点一下
		if focusInput { model.requestInputFocus() }
	}

	// MARK: - 接线

	private func wireModel() {
		model.onChange = { [weak self] in
			guard let self else { return }
			self.updateStatusIcon()
			self.maybeShowSetup()
		}
		model.onSpeechRequest = { [weak self] text in
			guard let self else { return }
			// 说话卡片只在**没人看着对话**的时候弹（判据见 SpeakingPolicy）。
			// 关键修正：记录窗口"开着"不等于"你看得见"——它可能被别的 app 盖住、
			// 或在别的 Space 上；你切走去干别的时，它的回复必须弹到眼前
			// （真实反馈："我给他发了消息，他回复我的时候并没有弹窗"）。
			let window = self.recordsWindow
			let recordsLiveOnScreen = self.recordsShowingLive
				&& (window?.isVisible ?? false)
				&& (window?.occlusionState.contains(.visible) ?? false)
			let show = SpeakingPolicy.shouldShowCard(
				panelShown: self.popover?.isShown ?? false,
				appActive: NSApp.isActive,
				recordsLiveOnScreen: recordsLiveOnScreen
			)
			if show { self.speakingCard.show(text: text) }
			if self.model.speakAloud { self.speech.speak(text) }
		}
		model.onLiveSectionChange = { [weak self] live in self?.recordsShowingLive = live }
		model.onQuestion = { [weak self] question, options in
			guard let self else { return }
			self.model.refreshNow()
			if !(self.popover?.isShown ?? false) { self.togglePopover(focusInput: false) }
			NSLog("Sprite: 它在问 %@ (%@)", question, options.joined(separator: "/"))
		}
		model.onToggleRecording = { [weak self] in self?.toggleRecording() }
		// 识别通道：用户的设置直接决定录音走哪条路
		dictation.useSystemRecognition = model.useSystemRecognition
		model.onRecognitionChannelChange = { [weak self] system in self?.dictation.useSystemRecognition = system }
		model.onOpenRecords = { [weak self] request in self?.openRecords(request) }
	}

	private func wireDictation() {
		dictation.onTranscript = { [weak self] text in
			guard let self else { return }
			// 注意：追加文字只发生在 onVoiceNote 一处。这里再追加一次会让同一句话进两遍
			// （onVoiceNote 与 onTranscript 都会触发）。
			self.model.voiceStatusText = L("转写完成，已放进输入框")
		}
		// 一段语音结束：音频 + 转写一起存进记忆。这是"内容丢失"的根治——
		// 即使面板被关掉、用户没点发送，原话也已经落在记忆里了。
		dictation.onVoiceNote = { [weak self] text, url, durationMs in
			guard let self else { return }
			let seconds = Double(durationMs) / 1000
			if text.isEmpty {
				// 设备端识别会**静默返回空**：音频里明明有人声，却一个字都没有。
				// 先把录音存进记忆（原话不能丢），再在面板上给一条"用系统识别再试"的路。
				self.model.voiceStatusText = String(format: L("录音结束（%.1f 秒）：设备端没听出内容"), seconds)
			} else {
				self.model.appendTranscript(text)
				self.model.voiceStatusText = String(format: L("录音结束（%.1f 秒），正在存进记忆…"), seconds)
			}
			self.model.commitVoice(transcript: text, audioURL: url, durationMs: durationMs) { [weak self] ok in
				guard let self else { return }
				guard ok, let note = self.model.archiveNote else { return }
				self.model.voiceStatusText = text.isEmpty ? Lf("%@　—— 没听出文字，可以点下面的「重新识别」", note) : note
			}
		}
		dictation.onLiveText = { [weak self] live in
			guard let self else { return }
			self.model.recordingLiveText = String(live.suffix(120))
			self.model.voiceStatusText = L("正在录…听到：") + String(live.suffix(30))
		}
		dictation.onStateChange = { [weak self] state in
			guard let self else { return }
			self.model.isRecording = state.isRecording
			switch state {
			case .recording:
				// 录音界面改成**独立浮层**：菜单栏图标可能被系统的麦克风标识挤掉，
				// 挂在它上面的面板会跟着消失，浮层不会。
				self.model.voicePhase = "recording"
				self.popover?.performClose(nil)
				self.recorder.show()
			case .transcribing:
				self.model.voicePhase = "transcribing"
				self.recorder.show()
			case .done(let text):
				self.model.voicePhase = "idle"
				self.recorder.hide()
				// 录完**自动把面板叫回来**：真实用户反馈——"没有在我点击完录音之后自动展开面板，
				// 我自己打开面板之后都没检查就直接发了"。面板回来、输入框聚焦，先看再发。
				if !(self.popover?.isShown ?? false) { self.togglePopover(focusInput: true) }
				// 电平体检：读一遍这一段的音频，算出"真的有说话声的秒数"。
				// 音频只有几百 KB，读一次是毫秒级；这是录完那一刻的一次性动作。
				let speaking = self.dictation.audioURL.flatMap { VoiceTranscriber.level(url: $0)?.speechSeconds }
				self.noteTranscriptQuality(text: text, speakingSeconds: speaking)
			case .idle, .failed, .needsPermission:
				self.model.voicePhase = "idle"
				self.recorder.hide()
				// 出问题了要让人看见原因：把面板叫回来（它不抢焦点）
				if !(self.popover?.isShown ?? false) { self.togglePopover(focusInput: false) }
			}
			if let captureIssue = self.dictation.lastCaptureFailed {
				self.model.archiveNote = captureIssue
			}
			switch state {
			case .idle: self.model.voiceStatusText = self.dictation.permissionSummary
			case .recording:
				self.model.voiceStatusText = L("正在录…再点一下停止")
				// 录制期间面板可能被关掉：图标上要留一个正在录的记号，
				// 否则用户不知道麦克风还开着（"点一下面板就没了"的现场）
				self.updateStatusIcon()
			case .transcribing: self.model.voiceStatusText = L("正在转写…")
			case .done(let text): self.model.voiceStatusText = L("转写完成：") + String(text.prefix(30))
			case .failed(let reason): self.model.voiceStatusText = "⚠︎ " + reason
			case .needsPermission(let reason): self.model.voiceStatusText = "⚠︎ " + reason
			}
		}
	}

	/// 给这一段的转写做一次"完整体检"，并如实说出来。
	///
	/// 真实事故：1 分 43 秒的录音只转出 20 字，用户没检查就发出去了——
	/// 界面当时什么都没说，这就是失职。
	private func noteTranscriptQuality(text: String, speakingSeconds: Double? = nil) {
		let seconds = Double(dictation.secondsRecorded)
		let channel = model.useSystemRecognition ? L("系统识别") : L("设备端识别")
		let characters = text.trimmingCharacters(in: .whitespacesAndNewlines).count
		if ShellModel.looksIncomplete(text: text, seconds: seconds, speakingSeconds: speakingSeconds) {
			// 说清楚判据：是"说话时长"和字数对不上，不是"录音太短"
			let speechNote = speakingSeconds.map { String(format: L("其中约 %.0f 秒有说话声"), $0) } ?? String(format: L("共 %.0f 秒"), seconds)
			model.voiceSummary = "⚠︎ " + speechNote + String(format: L("，只转出 %d 字（%@）——发之前先看一眼，或换个通道再试"), characters, channel)
			model.voiceNeedsRetry = model.lastVoiceFile != nil
		} else {
			let speechNote = speakingSeconds.map { String(format: L("（约 %.0f 秒说话声）"), $0) } ?? ""
			model.voiceSummary = String(format: L("录音 %.0f 秒%@，转写 %d 字（%@）"), seconds, speechNote, characters, channel)
			model.voiceNeedsRetry = false
		}
	}

	private func toggleRecording() {
		if dictation.state.isRecording {
			dictation.stop()
			return
		}
		// 权限还没问过 → 系统要弹窗。**先把下拉面板收起来**：
		// 真实用户反馈——面板钉在那儿挡住了权限弹窗的按钮，点不到"允许"，
		// 只能先跑去点菜单栏图标把面板关掉。要弹窗的时候什么都不该挡在前面。
		if dictation.willPrompt { popover?.performClose(nil) }
		dictation.start()
	}

	private func openRecords(_ request: RecordsSectionRequest = .live) {
		if recordsWindow == nil {
			// 走唯一的构造点（应用与 `--hang-check` 同一条路径，检查才有意义）
			let section: RecordsView.Section = {
				switch request {
				case .live: return .live
				case .voice: return .voice
				case .settings: return .settings
				case .diary: return .diary
				}
			}()
			let window = RecordsWindow.make(model: model, section: section)
			window.delegate = self // 关闭时清掉"正在看现在"的标志（否则卡片再也不弹）
			recordsWindow = window
		}
		popover?.performClose(nil)
		recordsWindow?.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	// MARK: - 主菜单（⌘C/⌘V 的前提）

	static func installEditMenu() {
		let mainMenu = NSMenu()
		let editItem = NSMenuItem()
		let editMenu = NSMenu(title: L("编辑"))
		editMenu.addItem(withTitle: L("拷贝"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
		editMenu.addItem(withTitle: L("粘贴"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
		editMenu.addItem(withTitle: L("剪切"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
		editMenu.addItem(.separator())
		editMenu.addItem(withTitle: L("全选"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
		editItem.submenu = editMenu
		mainMenu.addItem(editItem)
		NSApp.mainMenu = mainMenu
	}
}


// MARK: - 记录窗口关闭时清掉"正在看现在"的标志
//
// `onDisappear` 已经会清一次，但窗口被直接关掉时它不保证触发；
// 标志留成 true 的后果是**卡片再也不弹**（真实事故的成因之一）。
extension AppDelegate: NSWindowDelegate {
	public func windowWillClose(_ notification: Notification) {
		if let window = notification.object as? NSWindow, window === recordsWindow {
			recordsShowingLive = false
			recordsWindow = nil
		}
	}
}
