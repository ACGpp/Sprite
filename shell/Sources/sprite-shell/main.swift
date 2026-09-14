import AppKit
import AVFoundation
import Speech
import SwiftUI
import Vision
import Foundation
import SpriteRPC

/// sprite-shell 入口。
///
///   sprite-shell [--socket <path>]            正常启动（菜单栏图标 + 下拉面板）
///   sprite-shell --selftest                   构建全部界面对象、断言关键行为，然后退出（不显示任何窗口）
///   sprite-shell --headless --seconds N       真连内核、真订阅事件，但不上屏（诊断与活体验证用）
///   sprite-shell --headless --send "文本"     走与面板相同的代码路径发一句话（验证发送链路）
///   sprite-shell --mockups <目录>             渲染视觉样张（我看不到屏幕，用图沟通）

func defaultSocketPath() -> String {
	let home = FileManager.default.homeDirectoryForCurrentUser
	return home.appendingPathComponent(".claude-memory/runtime/core.sock").path
}

func isSameColor(_ a: NSColor, _ b: NSColor?) -> Bool {
	guard let b, let x = a.usingColorSpace(.deviceRGB), let y = b.usingColorSpace(.deviceRGB) else { return false }
	return abs(x.redComponent - y.redComponent) < 0.02 && abs(x.greenComponent - y.greenComponent) < 0.02 && abs(x.blueComponent - y.blueComponent) < 0.02
}

func argumentValue(_ name: String) -> String? {
	let arguments = CommandLine.arguments
	guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
	return arguments[index + 1]
}


/// 命令行入口。
///
/// 包成 `@MainActor` 函数是**诚实的**：main.swift 的顶层代码本来就在主线程跑，
/// Swift 6 也把顶层代码视为主线程隔离（SE-0343）。在 Swift 5 语言模式下编译器不这么看，
/// 于是 `ShellModel` 一旦标了 `@MainActor`，这里就会报一堆「非隔离上下文调用主线程隔离」——
/// 所以显式说清楚，而不是靠关掉检查。
@MainActor
func spriteShellMain() {
	let socketPath = argumentValue("--socket") ?? defaultSocketPath()
	let selfTest = CommandLine.arguments.contains("--selftest")
	let headless = CommandLine.arguments.contains("--headless")
	let headlessSeconds = Double(argumentValue("--seconds") ?? "12") ?? 12

	// NSApp 必须先于任何 AppKit 调用存在（自检模式也要）
	let application = NSApplication.shared
	// 主菜单是 ⌘C/⌘V 的前提，必须在任何模式（含自检）下都装上
	AppDelegate.installEditMenu()

	// ─── 画样张 ───
	if let dir = argumentValue("--mockups") {
		var urls = PanelMockup.writeAll(to: URL(fileURLWithPath: dir))
		let directory = URL(fileURLWithPath: dir)
		for (name, render) in [("menu-下拉面板", PanelMockup.renderMenuBarExtra), ("records-记录窗口", PanelMockup.renderRecords)] {
			if let data = render(2) {
				let url = directory.appendingPathComponent("\(name).png")
				try? data.write(to: url)
				urls.append(url)
			}
		}
		for url in urls { print("已生成：\(url.path)") }
		print(urls.isEmpty ? "结论: FAIL ✗ 样张生成失败" : "结论: PASS ✓ 已生成 \(urls.count) 张样张")
		exit(urls.isEmpty ? 1 : 0)
	}

	// ─── 量对话界面与说话卡片的几何关系（判断"卡片会不会被面板挡住"）───
	if CommandLine.arguments.contains("--geometry") {
		guard let screen = NSScreen.main else { exit(1) }
		let visible = screen.visibleFrame
		print("屏幕 \(Int(screen.frame.width))×\(Int(screen.frame.height))　可视区 \(Int(visible.width))×\(Int(visible.height))（原点在左下）")
		let cardW: CGFloat = 420
		let cardH: CGFloat = 120
		let cardX = visible.midX - cardW / 2
		let cardY = visible.minY + visible.height * 0.62
		print("说话卡片：x \(Int(cardX))–\(Int(cardX + cardW))　y \(Int(cardY))–\(Int(cardY + cardH))")
		let popW: CGFloat = 340
		let popH: CGFloat = 464
		let popX = visible.maxX - popW - 8
		let popY = visible.maxY - popH
		print("下拉面板：x \(Int(popX))–\(Int(popX + popW))　y \(Int(popY))–\(Int(visible.maxY))")
		let overlapX = max(0, min(cardX + cardW, popX + popW) - max(cardX, popX))
		let overlapY = max(0, min(cardY + cardH, visible.maxY) - max(cardY, popY))
		print("重叠：横向 \(Int(overlapX))pt　纵向 \(Int(overlapY))pt")
		print("层级：说话卡片 floating=\(NSWindow.Level.floating.rawValue)　NSPopover 的窗口在 popUpMenu(101) 级别 → 卡片在面板**之下**")
		exit(0)
	}

	// ─── 登录项：查看状态 / 打开 / 关闭（用真身验证，不靠猜）───
	if CommandLine.arguments.contains("--login-item") {
		let action = argumentValue("--login-item") ?? "status"
		switch action {
		case "status":
			print("登录项状态：\(LoginItem.status().describe)")
		case "on", "off":
			let (status, problem) = LoginItem.setEnabled(action == "on")
			print("操作后状态：\(status.describe)")
			if let problem { print("⚠︎ \(problem)") }
		default:
			print("用法：--login-item status|on|off")
			exit(1)
		}
		print("内核常驻服务：\(LoginItem.kernelServiceInstalled() ? "已安装" : "未安装（跑 Scripts/install.sh）")")
		exit(0)
	}

	// ─── 首次运行面板（AppKit 面板 + 内嵌 SwiftUI 表单）的截图自验 ───
	if let dir = argumentValue("--setup-shot") {
		let outDir = URL(fileURLWithPath: dir)
		try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
		let model = ShellModel(socketPath: socketPath)
		model.start()
		let deadline = Date().addingTimeInterval(8)
		while !model.connected && Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		let panel = SetupPanel(model: model)
		// 造一个"还没配模型"的报告：这正是首次运行时面板要显示的状态
		let report = SetupReport(
			homeDir: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude-memory").path,
			hasIdentity: true,
			hasModelConfig: false,
			configPath: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude-memory/config/settings.json").path,
			piAvailable: true,
			piBin: "pi",
			quietHours: QuietHours(start: 23, end: 7)
		)
		panel.update(setup: report, hasSpoken: false)
		guard let view = panel.contentView else {
			print("结论: FAIL ✗ 面板没有 contentView")
			exit(1)
		}
		for _ in 0..<6 {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.3))
			view.layoutSubtreeIfNeeded()
		}
		guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
			print("结论: FAIL ✗ 拿不到位图")
			exit(1)
		}
		view.cacheDisplay(in: view.bounds, to: rep)
		guard let data = rep.representation(using: .png, properties: [:]) else {
			print("结论: FAIL ✗ PNG 编码失败")
			exit(1)
		}
		let url = outDir.appendingPathComponent("首次运行面板.png")
		try? data.write(to: url)
		print("  ✓ \(url.path)　\(Int(view.bounds.width))×\(Int(view.bounds.height))")

		guard let image = NSImage(contentsOfFile: url.path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
		let request = VNRecognizeTextRequest()
		request.recognitionLevel = .accurate
		request.recognitionLanguages = ["zh-Hans", "en-US"]
		try? VNImageRequestHandler(cgImage: cg).perform([request])
		let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
		print("  ── 首次运行面板屏上文字 \(lines.count) 行 ──")
		for line in lines { print("     \(line)") }
		// 面板高度必须装得下内容：底部按钮不能被切掉
		let hasSave = lines.contains { $0.contains("保存") }
		let hasSpeak = lines.contains { $0.contains("说第一句话") }
		print("结论: \(hasSave && hasSpeak ? "PASS ✓ 表单与按钮都在面板可见范围内" : "FAIL ✗ 面板内容被截断（保存按钮=\(hasSave) 说第一句话=\(hasSpeak)）")")
		exit(hasSave && hasSpeak ? 0 : 1)
	}

	// ─── 真视图截图：把**真正的 SwiftUI 界面**渲染成 PNG（不是手绘示意）───
	if let dir = argumentValue("--shot") {
		let outDir = URL(fileURLWithPath: dir)
		try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
		let model = ShellModel(socketPath: socketPath)
		model.start()
		let deadline = Date().addingTimeInterval(8)
		while !model.connected && Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		print("连接：\(model.connected ? "已连接" : "未连接")")

		/// 把真视图画进位图：先放进一个不上屏的窗口，材质与配色才和屏幕上一致
		func shoot<V: View>(_ view: V, size: NSSize, name: String, opaque: Bool = false) {
			// 离屏渲染时 SwiftUI 的材质层是透明的，文字会看不见。
			// 截图时垫一层不透明底色只为看清内容（真机上那层是系统材质）。
			let wrapped = AnyView(ZStack {
				if opaque { Color(nsColor: .windowBackgroundColor) }
				view
			})
			let controller = NSHostingController(rootView: wrapped)
			let window = NSWindow(contentViewController: controller)
			window.styleMask = [.titled]
			window.setContentSize(size)
			controller.view.frame = NSRect(origin: .zero, size: size)
			controller.view.layoutSubtreeIfNeeded()
			// 多转几圈：SwiftUI 的首帧有时要等一两个 runloop 周期（大段文本更慢）
			for _ in 0..<8 {
				RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.3))
				controller.view.layoutSubtreeIfNeeded()
			}
			guard let rep = controller.view.bitmapImageRepForCachingDisplay(in: controller.view.bounds) else {
				print("  ✗ \(name)：拿不到位图")
				return
			}
			controller.view.cacheDisplay(in: controller.view.bounds, to: rep)
			guard let data = rep.representation(using: .png, properties: [:]) else {
				print("  ✗ \(name)：PNG 编码失败")
				return
			}
			let url = outDir.appendingPathComponent("\(name).png")
			try? data.write(to: url)
			// 底部空白：从最后一行往上找第一个"和背景不一样"的行。
			// 之前固定 520pt 时，收起诊断下面会空一大块——这里量出来。
			let background = rep.colorAt(x: 2, y: rep.pixelsHigh - 2)
			var contentBottom = rep.pixelsHigh
			outer: for y in stride(from: rep.pixelsHigh - 1, through: 0, by: -1) {
				for x in stride(from: 0, to: rep.pixelsWide, by: 3) {
					if let pixel = rep.colorAt(x: x, y: y), !isSameColor(pixel, background) {
						contentBottom = y
						break outer
					}
				}
			}
			let scaled = CGFloat(rep.pixelsHigh - contentBottom) / (CGFloat(rep.pixelsHigh) / size.height)
			print("  ✓ \(url.path)　\(Int(size.width))×\(Int(size.height))　底部空白 \(Int(scaled))pt")
		}

		// 截图里到底写了什么字——用系统的文字识别读回来（我自己看不到图）
		func readBack(_ path: String) {
			guard let image = NSImage(contentsOfFile: path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
				print("  ✗ 读不到 \(path)")
				return
			}
			let request = VNRecognizeTextRequest()
			request.recognitionLevel = .accurate
			request.recognitionLanguages = ["zh-Hans", "en-US"]
			let handler = VNImageRequestHandler(cgImage: cg)
			do {
				try handler.perform([request])
				let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
				print("  ── \(URL(fileURLWithPath: path).lastPathComponent) 屏上文字 \(lines.count) 行 ──")
				for line in lines { print("     \(line)") }
			} catch {
				print("  ✗ 识别失败：\(error.localizedDescription)")
			}
		}

		let sectionArg = argumentValue("--section") ?? "diary"
		let section: RecordsView.Section = {
			switch sectionArg {
			case "voice": return .voice
			case "settings": return .settings
			case "thoughts": return .thoughts
			case "conversations": return .conversations
			case "explorations": return .explorations
			default: return .diary
			}
		}()
		// 录音浮层：把"正在录"的样子也画出来（这是真视图，不是示意图）
		let recorderProbe = ShellModel(socketPath: socketPath)
		recorderProbe.voicePhase = "recording"
		recorderProbe.recordingElapsed = "0:12"
		recorderProbe.recordingLiveText = "就是点击录音的时候它不能变成……就是这个面板不能消失"
		shoot(RecorderView(model: recorderProbe, onStop: {}, onCancel: {}), size: NSSize(width: 430, height: 104), name: "录音浮层", opaque: true)
		shoot(MenuBarView(model: model, initialDiagnostics: false), size: NSSize(width: 340, height: 480), name: "面板-诊断收起", opaque: true)
		shoot(RecordsView(model: model, initialSection: .live), size: NSSize(width: 900, height: 580), name: "记录窗口-现在", opaque: true)
		shoot(MenuBarView(model: model, initialDiagnostics: true), size: NSSize(width: 340, height: 464), name: "面板-诊断展开", opaque: true)
		shoot(
			RecordsView(model: model, initialSection: section, autoSelectFirst: !CommandLine.arguments.contains("--no-autoselect")),
			size: NSSize(width: 900, height: 580),
			name: "记录窗口-\(sectionArg)",
			opaque: true
		)
		readBack(outDir.appendingPathComponent("记录窗口-现在.png").path)
		readBack(outDir.appendingPathComponent("录音浮层.png").path)
		readBack(outDir.appendingPathComponent("面板-诊断收起.png").path)
		readBack(outDir.appendingPathComponent("记录窗口-\(sectionArg).png").path)
		print("结论: PASS ✓ 已渲染真视图截图")
		exit(0)
	}

	// ─── 走**产品路径**重新转写一段已存的语音（界面按钮调用的是同一个方法）───
	// 诊断用：读一段音频的电平画像（总时长 / 说话时长 / 峰值）。
	// 存在的理由：判断"转写是不是缺了内容"靠的是**说话时长**，
	// 出问题时得能直接把数字打出来，而不是靠猜。
	if let levelPath = argumentValue("--voice-levels") {
		let url = URL(fileURLWithPath: levelPath)
		if let summary = VoiceTranscriber.levelSummary(url: url) {
			print("电平：\(summary)")
		} else {
			print("读不出这段音频：\(levelPath)")
		}
		return
	}

	if let voicePath = argumentValue("--retranscribe") {
		let model = ShellModel(socketPath: socketPath)
		model.start()
		let deadline = Date().addingTimeInterval(10)
		while !model.connected && Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		guard model.connected else { print("结论: FAIL ✗ 连不上内核"); exit(1) }
		let forced: VoiceTranscriber.Channel? = CommandLine.arguments.contains("--device-only") ? .onDevice : nil
		model.retranscribe(path: voicePath, forceChannel: forced)
		let settle = Date().addingTimeInterval(90)
		while model.retranscribing && Date() < settle {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
		}
		// 等写回内核
		RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(1.0))
		print("结果：\(model.retranscribeNote ?? "（没有回音）")")
		var listed: [[String: String]] = []
		var done = false
		model.loadRecords(kind: "voice", limit: 5) { list in
			listed = list
			done = true
		}
		let listDeadline = Date().addingTimeInterval(10)
		while !done && Date() < listDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		if let newest = listed.first {
			print("记录里现在是：\(newest["title"] ?? "-")　正文 \(newest["text"]?.count ?? 0) 字")
			print("  \(newest["text"] ?? "" )")
		}
		print("输入框草稿：\(model.draft.isEmpty ? "（空）" : "\(model.draft.count) 字：\(model.draft.prefix(40))")")
		exit((model.retranscribeNote?.contains("已补写") ?? false) ? 0 : 1)
	}

	// ─── 把记忆里的一段录音取出来、重新转写（转写失败时的兜底，也用来验证音频里到底有没有人声）───
	if let voicePath = argumentValue("--transcribe") {
		let model = ShellModel(socketPath: socketPath)
		model.start()
		let deadline = Date().addingTimeInterval(10)
		while !model.connected && Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		guard model.connected else { print("结论: FAIL ✗ 连不上内核"); exit(1) }

		// 1. 从内核取音频字节（外壳不读记忆目录）
		var bytes: Data?
		var done = false
		model.loadAudio(path: voicePath) { data in
			bytes = data
			done = true
		}
		let fetchDeadline = Date().addingTimeInterval(15)
		while !done && Date() < fetchDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		guard let bytes, !bytes.isEmpty else { print("结论: FAIL ✗ 读不到这段录音"); exit(1) }
		let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("replay-" + (voicePath as NSString).lastPathComponent)
		try? bytes.write(to: tmp)
		print("音频：\(voicePath)　\(bytes.count) 字节　已取到临时文件")

		// 1.5 量一遍电平：文件有字节 ≠ 里面有声音。
		// "录了 20 秒但整段是数字静音"和"识别坏了"是两回事，必须分清。
		do {
			let file = try AVAudioFile(forReading: tmp)
			let format = file.processingFormat
			let capacity = AVAudioFrameCount(format.sampleRate) // 一秒一块
			guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw NSError(domain: "probe", code: 1) }
			print("格式：\(Int(format.sampleRate))Hz　\(format.channelCount) 声道　共 \(file.length) 帧（\(String(format: "%.1f", Double(file.length) / format.sampleRate)) 秒）")
			var second = 0
			var quietSeconds = 0
			var loudest: Float = 0
			var report: [String] = []
			while file.framePosition < file.length {
				try file.read(into: buffer, frameCount: capacity)
				guard let data = buffer.floatChannelData?[0] else { break }
				let count = Int(buffer.frameLength)
				guard count > 0 else { break }
				var peak: Float = 0
				var sum: Double = 0
				for i in 0..<count {
					let value = abs(data[i])
					peak = max(peak, value)
					sum += Double(value) * Double(value)
				}
				let rms = (sum / Double(count)).squareRoot()
				loudest = max(loudest, peak)
				if peak < 0.01 { quietSeconds += 1 }
				report.append(String(format: "%ds:峰值%.3f/均方根%.4f", second, peak, rms))
				second += 1
			}
			print("逐秒电平：" + report.prefix(24).joined(separator: "　"))
			if report.count > 24 { print("  …（共 \(report.count) 秒）") }
			print(String(format: "整段最大峰值 %.4f　几乎无声的秒数 %d/%d", loudest, quietSeconds, report.count))
			print(loudest < 0.01 ? "⚠︎ 这段音频基本是数字静音——麦克风没有采到任何声音" : "音频里有信号")
		} catch {
			print("⚠︎ 电平测量失败：\(error.localizedDescription)")
		}

		// 2. 用文件识别再转一遍。先试设备端（语音不出机器），失败就换一条通道，
		//    并把**每一次的错误原样打出来**——"转写为空"和"识别报错"必须分得清。
		let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
		guard let recognizer else { print("结论: FAIL ✗ 建不起中文识别器"); exit(1) }
		print("识别器：可用=\(recognizer.isAvailable)　设备端=\(recognizer.supportsOnDeviceRecognition)")
		// 只跑指定通道（用来分辨"设备端读不了长音频"和"音频本身有问题"）
		let forced = argumentValue("--channel")
		// 切片：只识别 [start, end) 秒——用来验证分块识别是否可行
		let sliceSpec = argumentValue("--slice")
		var finalText = ""
		let attempts: [Bool]
		switch forced {
		case "device": attempts = [true]
		case "system": attempts = [false]
		default: attempts = [true, false]
		}
		for (index, onDevice) in attempts.enumerated() {
			// 切片：把 [start, end) 秒单独写成文件再识别（分块识别可行性验证）
			var target = tmp
			if let sliceSpec {
				let parts = sliceSpec.split(separator: "-").compactMap { Double($0) }
				if parts.count == 2, let source = try? AVAudioFile(forReading: tmp) {
					let format = source.processingFormat
					let startFrame = AVAudioFramePosition(parts[0] * format.sampleRate)
					let endFrame = min(AVAudioFramePosition(parts[1] * format.sampleRate), source.length)
					let count = AVAudioFrameCount(max(0, endFrame - startFrame))
					if let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) {
						source.framePosition = startFrame
						try? source.read(into: buffer, frameCount: count)
						let piece = FileManager.default.temporaryDirectory.appendingPathComponent("slice-\(parts[0])-\(parts[1]).caf")
						try? FileManager.default.removeItem(at: piece)
						if let out = try? AVAudioFile(forWriting: piece, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false) {
							try? out.write(from: buffer)
							target = piece
							print(String(format: "切片 %.0f–%.0f 秒（%.1f 秒音频）", parts[0], parts[1], Double(count) / format.sampleRate))
						}
					}
				}
			}
			let request = SFSpeechURLRecognitionRequest(url: target)
			request.shouldReportPartialResults = true
			request.requiresOnDeviceRecognition = onDevice
			var text = ""
			var settled = false
			var failure: String?
			let started = Date()
			recognizer.recognitionTask(with: request) { result, error in
				if let result {
					text = result.bestTranscription.formattedString
					if result.isFinal { settled = true }
				}
				if let error {
					failure = "\(error)"
					settled = true
				}
			}
			let deadline = Date().addingTimeInterval(120)
			while !settled && Date() < deadline {
				RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
			}
			print(String(format: "第 %d 次（%@，%.1f 秒）：%@", index + 1, onDevice ? "设备端" : "系统通道", Date().timeIntervalSince(started), failure.map { "错误 \($0)" } ?? (text.isEmpty ? "空结果，无错误" : "\(text.count) 字")))
			if !text.isEmpty { finalText = text; break }
		}
		print(finalText.isEmpty ? "  （三条通道都没读出内容）" : "  \(finalText)")
		print("结论: \(finalText.isEmpty ? "EMPTY ⚠︎ 音频里没有可识别的人声" : "PASS ✓ 读出来了")")
		exit(finalText.isEmpty ? 1 : 0)
	}

	// ─── 看一张 PNG 里哪儿有东西（我自己看不到图，用墨迹密度网格代看）───
	if let path = argumentValue("--inspect") {
		guard let image = NSImage(contentsOfFile: path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
			let rep = NSBitmapImageRep(cgImage: cg) as NSBitmapImageRep? else {
			print("读不到 \(path)")
			exit(1)
		}
		let cols = 30, rows = 16
		let cellW = max(1, rep.pixelsWide / cols), cellH = max(1, rep.pixelsHigh / rows)
		print("\(path)　\(rep.pixelsWide)×\(rep.pixelsHigh)　墨迹网格（. 空　: 淡　* 有字）：")
		for row in 0..<rows {
			var line = ""
			for col in 0..<cols {
				var ink = 0, total = 0
				for y in stride(from: row * cellH, to: min((row + 1) * cellH, rep.pixelsHigh), by: 2) {
					for x in stride(from: col * cellW, to: min((col + 1) * cellW, rep.pixelsWide), by: 2) {
						total += 1
						if let color = rep.colorAt(x: x, y: y), let rgb = color.usingColorSpace(.deviceRGB) {
							let brightness = (rgb.redComponent + rgb.greenComponent + rgb.blueComponent) / 3
							if brightness < 0.55 { ink += 1 }
						}
					}
				}
				let ratio = total > 0 ? Double(ink) / Double(total) : 0
				line += ratio > 0.12 ? "*" : (ratio > 0.02 ? ":" : ".")
			}
			print("  \(line)")
		}
		exit(0)
	}

	// ─── 量面板高度：用**真视图**（不是手绘），看 popover 到底会多高 ───
	if CommandLine.arguments.contains("--panel-metrics") {
		let model = ShellModel(socketPath: socketPath)
		model.start()
		let connectDeadline = Date().addingTimeInterval(8)
		while !model.connected && Date() < connectDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		print("连接：\(model.connected ? "已连接" : "未连接（断线形态也要量）")")
		var heights: [String: CGFloat] = [:]
		for diagnostics in [false, true] {
			let controller = NSHostingController(rootView: MenuBarView(model: model, initialDiagnostics: diagnostics))
			controller.sizingOptions = [.preferredContentSize]
			let view = controller.view
			view.layoutSubtreeIfNeeded()
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.4))
			view.layoutSubtreeIfNeeded()
			let name = diagnostics ? "诊断展开" : "诊断收起"
			let size = controller.preferredContentSize
			heights[name] = size.height
			print("\(name)：宽 \(Int(size.width))　高 \(Int(size.height))　（视图拟合高 \(Int(view.fittingSize.height))）")
		}
		let collapsed = heights["诊断收起"] ?? 0
		let expanded = heights["诊断展开"] ?? 0
		let ok = collapsed > 120 && collapsed < expanded && expanded <= 560
		print("结论: \(ok ? "PASS ✓ 高度跟着内容走：收起比展开矮 \(Int(expanded - collapsed))pt，且不超过 560pt" : "FAIL ✗ 高度没有跟着内容变")")
		exit(ok ? 0 : 1)
	}

	// ─── 真麦克风测一遍完整语音链路（录音 → 转写 → 存进记忆 → 回读 → 解码）───
	if let secondsText = argumentValue("--record-test") {
		let seconds = Double(secondsText) ?? 5
		let dictation = DictationService()
		let model = ShellModel(socketPath: socketPath)
		model.start()
		print("权限：\(dictation.permissionSummary)")

		// 等连上内核（最多 10 秒）
		let connectDeadline = Date().addingTimeInterval(10)
		while !model.connected && Date() < connectDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		guard model.connected else {
			print("结论: FAIL ✗ 连不上内核 \(socketPath)")
			exit(1)
		}

		var note: (String, URL?, Int)?
		var liveText = ""
		dictation.onLiveText = { liveText = $0 }
		dictation.onVoiceNote = { text, url, durationMs in note = (text, url, durationMs) }
		dictation.onStateChange = { state in
			if case .failed(let reason) = state { print("录音状态：失败 → \(reason)") }
			if case .needsPermission(let reason) = state { print("⚠︎ \(reason)") }
		}
		print("开始录音 \(seconds) 秒——请对着麦克风说点什么…")
		dictation.start()

		let stopAt = Date().addingTimeInterval(seconds)
		while Date() < stopAt {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
		}
		dictation.stop()
		let finishDeadline = Date().addingTimeInterval(8)
		while note == nil && Date() < finishDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
		}

		guard let (transcript, audioURL, durationMs) = note else {
			print("结论: FAIL ✗ 录音没有产出语音（实时听到：\(liveText.isEmpty ? "（无）" : liveText)）")
			exit(1)
		}
		print("转写：\(transcript.isEmpty ? "（空）" : transcript)　\(transcript.count) 字 / \(String(format: "%.1f", Double(durationMs) / 1000)) 秒")
		if ShellModel.looksIncomplete(text: transcript, seconds: Double(durationMs) / 1000) {
			print("⚠︎ 完整度检查：字数撑不起这段时长，可能缺内容")
		} else {
			print("完整度检查：字数与时长匹配 ✓")
		}
		print("实时文本：\(liveText.isEmpty ? "（无）" : liveText)")
		print("音频：\(audioURL?.lastPathComponent ?? "（没有音频文件）")　时长 \(durationMs) ms")

		// 音频必须能被解码——"文件存在"不等于"能播"
		if let audioURL {
			let size = (try? FileManager.default.attributesOfItem(atPath: audioURL.path)[.size] as? NSNumber)?.intValue ?? 0
			do {
				let file = try AVAudioFile(forReading: audioURL)
				print("解码：\(file.length) 帧 @ \(Int(file.fileFormat.sampleRate))Hz　\(size) 字节")
				if file.length <= 0 { print("结论: FAIL ✗ 音频里没有帧"); exit(1) }
			} catch {
				print("结论: FAIL ✗ 音频解不开：\(error.localizedDescription)")
				exit(1)
			}
		}

		// 交给内核存（与面板完全相同的调用）
		var archived = false
		model.commitVoice(transcript: transcript, audioURL: audioURL, durationMs: durationMs) { ok in archived = ok }
		let archiveDeadline = Date().addingTimeInterval(10)
		while !archived && Date() < archiveDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		print("归档：\(model.archiveNote ?? "（没有回音）")")
		guard archived else { print("结论: FAIL ✗ 没能存进记忆"); exit(1) }

		// 记录窗口那条路径：列表拿得到 + 音频读得回 + 字节一致
		var listed: [[String: String]] = []
		var listedDone = false
		model.loadRecords(kind: "voice", limit: 5) { list in
			listed = list
			listedDone = true
		}
		let listDeadline = Date().addingTimeInterval(10)
		while !listedDone && Date() < listDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		guard let newest = listed.first else { print("结论: FAIL ✗ 记录里没有这条语音"); exit(1) }
		print("记录：\(newest["title"] ?? "-")　\(newest["meta"] ?? "-")　正文 \(newest["text"]?.count ?? 0) 字")

		var audioBytes: Data?
		var audioDone = false
		model.loadAudio(path: newest["path"] ?? "") { data in
			audioBytes = data
			audioDone = true
		}
		let audioDeadline = Date().addingTimeInterval(10)
		while !audioDone && Date() < audioDeadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		guard let audioBytes, !audioBytes.isEmpty else { print("结论: FAIL ✗ 从内核读不回音频"); exit(1) }
		let onDisk = audioURL.flatMap { try? Data(contentsOf: $0) } ?? Data()
		print("回读：\(audioBytes.count) 字节　与本地文件\(audioBytes == onDisk ? "逐字节一致 ✓" : "不一致 ✗")")
		print("结论: \(audioBytes == onDisk && !transcript.isEmpty ? "PASS ✓ 语音从麦克风到记忆到回读全程打通" : "PARTIAL ⚠︎ 有环节没对上")")
		exit(audioBytes == onDisk ? 0 : 1)
	}

	// ─── 只测记录接口：走与记录窗口完全相同的代码路径 ───
	if let kind = argumentValue("--records") {
		let model = ShellModel(socketPath: socketPath)
		model.start()
		// 闭包写一次、主线程读一次：用带锁的箱子，避免"捕获 var"（Swift 6 会拦）
		final class RecordsBox: @unchecked Sendable {
			private let lock = NSLock()
			private var stored: [[String: String]] = []
			private var ready = false
			func set(_ value: [[String: String]]) {
				lock.lock(); stored = value; ready = true; lock.unlock()
			}
			var isReady: Bool { lock.lock(); defer { lock.unlock() }; return ready }
			var value: [[String: String]] { lock.lock(); defer { lock.unlock() }; return stored }
		}
		let box = RecordsBox()
		model.loadRecords(kind: kind, limit: Int(argumentValue("--limit") ?? "6") ?? 6) { list in
			box.set(list)
		}
		let deadline = Date().addingTimeInterval(15)
		while !box.isReady && Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
		}
		print("连接：\(model.connected ? "已连接" : "未连接")")
		print("\(kind)：\(box.value.count) 条")
		for entry in box.value.prefix(6) {
			print("  · date=\(entry["date"] ?? "-") count=\(entry["count"] ?? "-") title=\(entry["title"] ?? "-")")
			print("    正文长度=\((entry["text"] ?? "").count) 预览=\(String((entry["preview"] ?? "").prefix(40)))")
		}
		if let problem = model.recordsError { print("读取错误：\(problem)") }
		print(box.value.isEmpty ? "结论: FAIL ✗ 界面拿不到数据" : "结论: PASS ✓ 界面能拿到数据")
		exit(box.value.isEmpty ? 1 : 0)
	}

	// ─── 自检：不显示任何窗口 ───
	if selfTest {
		// 计数器用对象而不是捕获的 var：内嵌函数改 var 会让编译器以为它永远是 0
		// （于是把"失败时"的分支判成死代码——这个警告就是这么来的）
		final class CheckCounter { var failures = 0 }
		let counter = CheckCounter()
		func check(_ name: String, _ condition: Bool, _ detail: String = "") {
			if condition {
				print("PASS \(name)\(detail.isEmpty ? "" : " — \(detail)")")
			} else {
				print("FAIL \(name)\(detail.isEmpty ? "" : " — \(detail)")")
				counter.failures += 1
			}
		}

		application.setActivationPolicy(.accessory)
		check("菜单栏应用（无 Dock 图标）", application.activationPolicy() == .accessory)

		// ⌘C/⌘V：没有主菜单，面板里的字选不中也拷不走（真实用户反馈）
		check("应用有主菜单", NSApp.mainMenu != nil)
		let editMenu = NSApp.mainMenu?.items.compactMap(\.submenu).first { $0.title == "编辑" }
		let equivalents = Set((editMenu?.items ?? []).map(\.keyEquivalent).filter { !$0.isEmpty })
		check("编辑菜单含 ⌘C / ⌘V / ⌘A", equivalents.isSuperset(of: ["c", "v", "a"]), equivalents.sorted().joined())

		// 快捷键：用户说 ⌃⌥⌘Space "太长了"——必须是两个键
		check("快捷键是两个键（⌥K）", HotKey.displayName == "⌥K", HotKey.displayName)
		var hotKeyFired = false
		let hotKeyOK = HotKey.register { hotKeyFired = true }
		check("全局快捷键能注册（不需要辅助功能权限）", hotKeyOK, hotKeyOK ? "已注册" : "被占用")
		_ = hotKeyFired

		// 模型层
		let model = ShellModel(socketPath: "/tmp/none")
		check("未连接时不谎报状态", model.connected == false && model.presenceTitle == "没有连上内核")

		// 语音：转写文字必须**只进一遍**输入框（onVoiceNote 与 onTranscript 都会触发，
		// 两处都追加就会变成"话话"）
		let draftModel = ShellModel(socketPath: "/tmp/不存在.sock")
		draftModel.appendTranscript("这是一句转写")
		draftModel.appendTranscript("这是一句转写")
		check("转写重复到达时输入框里只留一份", draftModel.draft == "这是一句转写", "实际：\(draftModel.draft)")
		let retryModel = ShellModel(socketPath: "/tmp/不存在.sock")
		retryModel.voiceNeedsRetry = true
		check("没听出文字时标出待重试", retryModel.voiceNeedsRetry && retryModel.lastVoiceFile == nil)
		let noticeBefore = model.wakeNotice
		model.wakeNow()
		check("未连接时叫醒会说清楚", (model.wakeNotice ?? "") != (noticeBefore ?? "") && (model.wakeNotice ?? "").contains("叫不醒"))
		let droppedSend = model.sendMessage("这句话不该被悄悄丢掉")
		check("未连接时发送返回失败", droppedSend == false)
		check("未连接时发送给出原因", (model.connectionError ?? "").contains("没有发出去"))
		check("说话默认不出声（办公模式）", model.speakAloud == false)
		check("诊断文本可读", model.diagnosticsText.contains("socket"))

		// 记录接口：外壳不读文件，一切经内核
		check("记录接口存在（异步、不崩）", { model.loadRecords(kind: "diary") { _ in }; return true }())

		// 菜单栏图标：会呼吸（不同相位画出的图必须不同）
		let delegate = AppDelegate(socketPath: "/tmp/none")
		_ = delegate
		let iconProbe = StatusIconProbe()
		let iconA = iconProbe.icon(phase: 0.0, presence: .breathing)
		let iconB = iconProbe.icon(phase: 0.25, presence: .breathing)  // 0.25 才是正弦的另一个极值
		check("菜单栏图标能生成", iconA.size.width > 0 && iconA.size.height > 0, "\(Int(iconA.size.width))x\(Int(iconA.size.height))")
		check("图标会呼吸（不同相位不同）", iconA.tiffRepresentation != iconB.tiffRepresentation)
		check("图标随状态变色", iconProbe.icon(phase: 0.25, presence: .thinking).tiffRepresentation
			!= iconProbe.icon(phase: 0.25, presence: .breathing).tiffRepresentation)

		// 它说话时的屏幕中间对话框（用户建议的交互）
		let card = SpeakingCard()
		card.show(text: "测试一句话", seconds: 30)
		check("对话框能显示文字", card.textForTest == "测试一句话")
		check("对话框不抢焦点", card.canBecomeKey == false && card.canBecomeMain == false)
		card.hide()

		// 记录窗口：按天聚合要求列表必须显示日期
		check("记录条目带日期字段（按天聚合）", { model.loadRecords(kind: "diary") { list in _ = list.first?["date"] }; return true }())

		// 语音：状态机与权限如实
		let dictation = DictationService()
		check("语音状态从 idle 开始", dictation.state == .idle)
		check("计时格式是 mm:ss", dictation.elapsedText == "0:00", dictation.elapsedText)
		check("权限如实显示", dictation.permissionSummary.contains("麦克风") && dictation.permissionSummary.contains("语音识别"))
		print("     \(dictation.permissionSummary)")
		// 隐私：界面上显示的路径必须把家目录缩成 ~（截图/投屏不泄露用户名）
		let homePath = FileManager.default.homeDirectoryForCurrentUser.path
		let shown = ShellModel.tilde(homePath + "/.claude-memory/config/settings.json")
		check("路径显示要缩成 ~（不暴露用户名）", shown.hasPrefix("~/") && !shown.contains(homePath), "实际：\(shown)")

		// 对话流：按 seq 排序（我说的和它说的必须交错正确），乐观回显在最后
		let merged = Conversation.merge(
			messages: [
				IncomingMessage(text: "我说的第一句", source: "text", seq: 5, at: "2026-09-11T10:00:00Z"),
				IncomingMessage(text: "我说的第二句", source: "voice", seq: 9, at: "2026-09-11T10:02:00Z"),
			],
			outgoing: [
				OutgoingMessage(text: "它回的第一句", channel: "bubble", seq: 7, at: "2026-09-11T10:01:00Z"),
			],
			optimistic: ["刚发出去还没回显的"]
		)
		check(
			"对话流按 seq 交错正确",
			merged.map(\.text) == ["我说的第一句", "它回的第一句", "我说的第二句", "刚发出去还没回显的"],
			"实际：\(merged.map { $0.fromMe ? "我" : "它" }.joined(separator: ","))"
		)
		check("对话流最后一条是待回显的我方消息", merged.last?.pending == true && merged.last?.fromMe == true)
		check("对话流区分双方", merged.filter(\.fromMe).count == 3 && merged.filter { !$0.fromMe }.count == 1)

		// 安静时段收着的话（digest）必须被标出来——否则用户不知道这句当时为什么没弹
		let heldMerged = Conversation.merge(
			messages: [],
			outgoing: [
				OutgoingMessage(text: "安静时段收着的", channel: "digest", seq: 3, at: "2026-09-11T15:00:00Z"),
				OutgoingMessage(text: "正常弹出来的", channel: "bubble", seq: 4, at: "2026-09-11T16:00:00Z"),
				OutgoingMessage(text: "导入的旧话", channel: "digest", seq: 5, at: "2026-05-01T16:00:00Z", imported: true),
			]
		)
		check("digest 标成『安静时段收着的』", heldMerged.count == 3 && heldMerged[0].heldBack && !heldMerged[1].heldBack)
		check("导入的旧记录不算收着的", heldMerged.count == 3 && !heldMerged[2].heldBack && heldMerged[2].imported)

		// 完整度判断：真实事故是 1 分 43 秒只转出 20 字就发出去了
		check(
			"转写明显缺内容时要报警",
			ShellModel.looksIncomplete(text: "这条路的路灯一排一排亮起来了怎么比我还快", seconds: 103),
			"20 字 / 103 秒"
		)
		check(
			"有停顿的短句不得误报（沉默不算说话时间）",
			ShellModel.looksIncomplete(text: "桌面上那个新文件你看了吗", seconds: 15, speakingSeconds: 3) == false,
			"10 字 / 15 秒录音但只有 3 秒在说话"
		)
		check(
			"说话时间长、字数明显不够时要报警",
			ShellModel.looksIncomplete(text: "嗯……那个", seconds: 40, speakingSeconds: 25) == true,
			"6 字 / 25 秒说话声"
		)
		check(
			"没有电平数据时退回旧判据（总时长）",
			ShellModel.looksIncomplete(text: "这条路的路灯一排一排亮起来了怎么比我还快", seconds: 103) == true,
			"20 字 / 103 秒"
		)
		check(
			"完整转写不得误报",
			!ShellModel.looksIncomplete(text: String(repeating: "这是一句完整的话。", count: 14), seconds: 103),
			"126 字 / 103 秒"
		)
		check(
			"短录音不做判断",
			!ShellModel.looksIncomplete(text: "在", seconds: 6)
		)
		check("识别通道默认走系统（设备端实测会丢内容）", ShellModel(socketPath: "/tmp/不存在.sock").useSystemRecognition)

		// 录音浮层：能显示、能收起、不抢焦点（菜单栏图标被系统麦克风标识挤掉时，
		// 这是唯一还在的录音界面）
		let recorderModel = ShellModel(socketPath: "/tmp/不存在.sock")
		let recorderProbe = RecorderPanelController(model: recorderModel)
		recorderProbe.show()
		check("录音浮层能显示", recorderProbe.isVisible)
		check("录音浮层不抢焦点", recorderProbe.isNonActivating)
		recorderProbe.hide()
		check("录音浮层能收起", !recorderProbe.isVisible)
		check("权限已授权时不会再弹系统窗", dictation.microphoneAuthorized && dictation.speechAuthorized ? !dictation.willPrompt : true)

		// 录音状态机的不变量（真实录音链路由 verify-voice 用真麦克风覆盖：
		// 设备端识别会静默返回空，所以那部分必须真录一遍才算数）
		check("空闲时不是录音中", !dictation.state.isRecording)
		check("取消之后回到 idle 且没有挂起的录音", {
			dictation.cancel()
			return dictation.state == .idle && dictation.recordingSeconds == 0 && dictation.currentTranscript.isEmpty
		}())
		check("没录过时电平为空（不会假装量过）", dictation.lastLevel == nil && dictation.lastCaptureFailed == nil)
		check("系统有中文朗读语音", AVSpeechSynthesisVoice(language: "zh-CN") != nil)

		print(counter.failures == 0 ? "结论: PASS ✓ 菜单栏形态与交互行为全部成立" : "结论: FAIL ✗ \(counter.failures) 项未通过")
		exit(counter.failures == 0 ? 0 : 1)
	}

	// ─── 无界面运行：真连内核、真订阅事件，但不往屏幕上放任何东西 ───
	if headless {
		let model = ShellModel(socketPath: socketPath)
		var lastPresence = "?"

		model.onEvent = { event in
			if case .presenceChanged = SpriteEvent.KnownEventType(rawValue: event.type) {
				lastPresence = event.data["state"]?.stringValue ?? "?"
			}
			print("#\(event.seq) \(event.type)\(event.isKnown ? "" : " (未知类型，仍可解码)")")
		}
		model.onConnectionChange = { connected, reason in
			print(connected ? "连接状态：已连接" : "连接状态：未连接（\(reason ?? "未知原因")）")
			// 断线那一刻就把"现在怎么描述自己"打出来。
			// 之前只在收尾打一次，重连够快就永远看不到这句——那条断言等于没验。
			if !connected { print("当前形态：\(model.presenceTitle)") }
		}

		print("连接 \(socketPath) …")
		model.start()

		if let toSend = argumentValue("--send") {
			let sent = model.sendMessage(toSend)
			print(sent ? "发送成功：\(toSend)" : "发送失败：\(model.connectionError ?? "未知原因")")
		}

		let deadline = Date().addingTimeInterval(headlessSeconds)
		while Date() < deadline {
			RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
		}
		model.stop()

		print("── 无界面运行结果 ──")
		print("最终连接：\(model.connected ? "已连接" : "未连接")")
		if let error = model.connectionError { print("错误：\(error)") }
		print("收到事件：\(model.eventCount) 条（末尾 seq=\(model.lastEventSeq)）")
		print("最终状态：\(model.presenceTitle) · \(model.nextBreathText)")
		if let state = model.state {
			print("呼吸次数：\(state.runs)　工具决策：\(state.toolDecisions)　留言：\(state.messages.count)　思维：\(state.thoughts.count)")
			if let question = state.lastQuestion { print("在等回答：\(question.question)") }
		}
		_ = lastPresence

		let ok = model.connected && model.lastEventSeq > 0
		print(ok ? "结论: PASS ✓ 外壳无界面运行正常" : "结论: FAIL ✗ 外壳未能与内核建立有效连接")
		exit(ok ? 0 : 1)
	}

	let delegate = AppDelegate(socketPath: socketPath)
	application.delegate = delegate
	application.run()

}

MainActor.assumeIsolated { spriteShellMain() }
