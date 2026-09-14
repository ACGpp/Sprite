import AppKit
import SwiftUI
import SpriteRPC

/// 首次见面：原生三步引导。
///
/// 原则与旧版向导的区别：
///   - **每一条判断都来自内核**（`SetupReport`），外壳不读文件、不猜状态；
///   - 缺什么就说什么，并给出**可执行的那一行命令**，不说"请自行配置"；
///   - 不阻塞：存在体照常出现在桌面上，引导只是把话说明白。
public final class SetupPanel: NSPanel {
	private let stepsStack = NSStackView()
	private let subtitleLabel = NSTextField(wrappingLabelWithString: "")
	private var reports: SetupReport?
	private var hasSpoken = false

	public var onOpenConfigFolder: (() -> Void)?
	/// 首次运行：模型还没配好就打开这张面板（表单就在里面）
	public func refresh() {
		update(setup: model.snapshot?.setup, hasSpoken: (model.state?.outgoing.contains { ($0.imported ?? false) == false } ?? false))
	}
	public var onSpeakFirstWords: (() -> Void)?
	public var onRecheck: (() -> Void)?

	private let model: ShellModel
	private var formHost: NSView?

	public init(model: ShellModel) {
		self.model = model
		super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 720), styleMask: [.titled, .closable], backing: .buffered, defer: false)
		build()
	}

	private func build() {
		titleVisibility = .hidden
		titlebarAppearsTransparent = true
		isMovableByWindowBackground = true
		level = .floating
		collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

		let container = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 720))

		let kicker = NSTextField(labelWithString: "SPRITE · 第一次见面")
		kicker.frame = NSRect(x: 24, y: 676, width: 400, height: 16)
		kicker.font = .systemFont(ofSize: 11, weight: .medium)
		kicker.textColor = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
		container.addSubview(kicker)

		let heading = NSTextField(labelWithString: "让它在你的 Mac 上醒来")
		heading.frame = NSRect(x: 24, y: 646, width: 460, height: 24)
		heading.font = .systemFont(ofSize: 18, weight: .semibold)
		container.addSubview(heading)

		subtitleLabel.frame = NSRect(x: 24, y: 606, width: 512, height: 32)
		subtitleLabel.font = .systemFont(ofSize: 12)
		subtitleLabel.textColor = .secondaryLabelColor
		subtitleLabel.stringValue = "记忆只留在本机（~/.claude-memory）。完成下面三步，之后打开应用就能直接继续。"
		container.addSubview(subtitleLabel)

		stepsStack.frame = NSRect(x: 24, y: 468, width: 512, height: 130)
		stepsStack.orientation = .vertical
		stepsStack.alignment = .leading
		stepsStack.spacing = 10
		container.addSubview(stepsStack)

		// 模型配置表单：与记录窗口的「设置」页是同一个视图。
		// 以前这一步是"去 config/llm.conf 里写 PI_MODEL 与 PI_API_KEY"——对不懂命令行的人是道墙。
		let form = NSHostingView(rootView: SettingsView(model: model, compact: true))
		form.frame = NSRect(x: 16, y: 64, width: 528, height: 396)
		container.addSubview(form)
		formHost = form

		let recheck = NSButton(title: "重新检测", target: self, action: #selector(handleRecheck))
		recheck.frame = NSRect(x: 24, y: 20, width: 100, height: 30)
		recheck.bezelStyle = .rounded
		container.addSubview(recheck)

		let openConfig = NSButton(title: "打开配置目录", target: self, action: #selector(handleOpenConfig))
		openConfig.frame = NSRect(x: 130, y: 20, width: 120, height: 30)
		openConfig.bezelStyle = .rounded
		container.addSubview(openConfig)

		let speak = NSButton(title: "说第一句话", target: self, action: #selector(handleSpeak))
		speak.frame = NSRect(x: 436, y: 20, width: 100, height: 30)
		speak.bezelStyle = .rounded
		speak.keyEquivalent = "\r"
		container.addSubview(speak)

		subtitleLabel.isSelectable = true
		contentView = container
	}

	required init?(coder: NSCoder) { fatalError("不支持 nib") }

	@objc private func handleRecheck() { onRecheck?() }
	@objc private func handleOpenConfig() { onOpenConfigFolder?() }
	@objc private func handleSpeak() {
		orderOut(nil)
		onSpeakFirstWords?()
	}

	/// 用内核给的报告刷新三步；`hasSpoken` 来自读模型里的留言数。
	public func update(setup: SetupReport?, hasSpoken: Bool) {
		reports = setup
		self.hasSpoken = hasSpoken
		for view in stepsStack.arrangedSubviews {
			stepsStack.removeArrangedSubview(view)
			view.removeFromSuperview()
		}
		guard let setup else {
			subtitleLabel.stringValue = "还没有连上内核，读不到它的状态。内核是唯一的真相来源——先让它跑起来。"
			return
		}
		let steps = setup.steps(hasSpoken: hasSpoken)
		if steps.allSatisfy(\.done) {
			subtitleLabel.stringValue = "三步都完成了。它会自己醒来、自己待着，偶尔跟你说句话。"
		} else {
			subtitleLabel.stringValue = "记忆只留在本机（\(ShellModel.tilde(setup.homeDir))）。下面三步：填模型 → 说第一句话。配置不用你新建文件，在表里填就行。"
		}
		for (index, step) in steps.enumerated() {
			let row = NSStackView()
			row.orientation = .horizontal
			row.alignment = .top
			row.spacing = 10

			let mark = NSTextField(labelWithString: step.done ? "✓" : "○")
			mark.font = .systemFont(ofSize: 14, weight: .semibold)
			mark.textColor = step.done
				? NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
				: .tertiaryLabelColor
			mark.setContentHuggingPriority(.required, for: .horizontal)

			let text = NSTextField(wrappingLabelWithString: "")
			let attributed = NSMutableAttributedString(
				string: "\(index + 1). \(step.title)\n",
				attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium)]
			)
			attributed.append(NSAttributedString(
				string: step.detail,
				attributes: [
					.font: NSFont.systemFont(ofSize: 11),
					.foregroundColor: NSColor.secondaryLabelColor,
				]
			))
			text.attributedStringValue = attributed
			text.preferredMaxLayoutWidth = 370

			row.addArrangedSubview(mark)
			row.addArrangedSubview(text)
			stepsStack.addArrangedSubview(row)
		}
	}

	/// 自检用：当前渲染出的步骤（不依赖界面层做判断）
	public var renderedSteps: [SetupStep] {
		guard let reports else { return [] }
		return reports.steps(hasSpoken: hasSpoken)
	}
}
