import AppKit
import SwiftUI

/// 它说话时，屏幕中间浮出的一张卡。
///
/// 用户的原话："如果屏幕中间出现个对话框，它在想象中会比较好，交互体验上。"
/// 所以它主动说话不再是"藏在菜单栏面板里的某一行"，而是**看得见的一张卡**：
///   · 不抢焦点（nonactivatingPanel + canBecomeKey=false）——你正在打字的窗口不会被打断
///   · 屏幕水平居中、偏上（约 1/3 处），10 秒后自动淡出
///   · 卡上有「回一句」——点它才打开菜单栏面板（对话入口仍在菜单栏，这里只是通知）
final class SpeakingCard: NSPanel {
	private let label = NSTextField(wrappingLabelWithString: "")
	private let replyButton = NSButton(title: L("回一句"), target: nil, action: nil)
	private let dismissButton = NSButton(title: L("知道了"), target: nil, action: nil)
	private var hideWorkItem: DispatchWorkItem?

	var onReply: (() -> Void)?

	override var canBecomeKey: Bool { false }
	override var canBecomeMain: Bool { false }

	init() {
		super.init(
			contentRect: NSRect(x: 0, y: 0, width: 420, height: 120),
			styleMask: [.borderless, .nonactivatingPanel],
			backing: .buffered,
			defer: false
		)
		// NSPopover 的窗口在 popUpMenu 级别：卡片必须比它高一档，
		// 否则"它说话"的浮卡会被下拉面板压住（真实用户反馈）
		level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)
		isOpaque = false
		backgroundColor = .clear
		hasShadow = true
		hidesOnDeactivate = false
		collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
		appearance = NSAppearance(named: .darkAqua)

		let container = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 120))
		container.wantsLayer = true
		container.layer?.backgroundColor = NSColor(calibratedRed: 0.075, green: 0.09, blue: 0.10, alpha: 0.96).cgColor
		container.layer?.cornerRadius = 16
		container.layer?.borderWidth = 1
		container.layer?.borderColor = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 0.30).cgColor

		let who = NSTextField(labelWithString: L("它"))
		who.frame = NSRect(x: 20, y: 86, width: 60, height: 18)
		who.font = .systemFont(ofSize: 11, weight: .medium)
		who.textColor = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
		who.isSelectable = true
		container.addSubview(who)

		label.frame = NSRect(x: 20, y: 38, width: 380, height: 44)
		label.font = .systemFont(ofSize: 14)
		label.textColor = NSColor(calibratedWhite: 0.95, alpha: 1)
		label.maximumNumberOfLines = 4
		label.isSelectable = true
		container.addSubview(label)

		style(replyButton, frame: NSRect(x: 300, y: 10, width: 100, height: 24), emphasized: true)
		replyButton.target = self
		replyButton.action = #selector(handleReply)
		container.addSubview(replyButton)

		style(dismissButton, frame: NSRect(x: 228, y: 10, width: 66, height: 24), emphasized: false)
		dismissButton.target = self
		dismissButton.action = #selector(handleDismiss)
		container.addSubview(dismissButton)

		contentView = container
	}

	required init?(coder: NSCoder) { fatalError("不支持 nib") }

	private func style(_ button: NSButton, frame: NSRect, emphasized: Bool) {
		button.frame = frame
		button.isBordered = false
		button.font = .systemFont(ofSize: 12, weight: emphasized ? .medium : .regular)
		button.contentTintColor = emphasized
			? NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
			: NSColor(calibratedWhite: 0.65, alpha: 1)
		button.wantsLayer = true
		button.layer?.cornerRadius = 7
		button.layer?.backgroundColor = NSColor(calibratedWhite: 1, alpha: emphasized ? 0.12 : 0.05).cgColor
	}

	@objc private func handleReply() {
		hide()
		onReply?()
	}

	@objc private func handleDismiss() { hide() }

	func show(text: String, seconds: Double = 10) {
		label.stringValue = text

		// 高度随文字量增长（最多 4 行）
		let measure = NSRect(x: 0, y: 0, width: 380, height: 400)
		let height = max(112, min(190, 96 + label.attributedStringValue.boundingRect(with: measure.size, options: [.usesLineFragmentOrigin]).height))
		setContentSize(NSSize(width: 420, height: height))
		contentView?.frame = NSRect(x: 0, y: 0, width: 420, height: height)
		label.frame = NSRect(x: 20, y: 38, width: 380, height: height - 76)
		replyButton.frame = NSRect(x: 300, y: 10, width: 100, height: 24)
		dismissButton.frame = NSRect(x: 228, y: 10, width: 66, height: 24)

		// 屏幕水平居中、偏上（约 1/3 处）
		if let screen = NSScreen.main {
			let visible = screen.visibleFrame
			setFrameOrigin(NSPoint(
				x: visible.midX - frame.width / 2,
				y: visible.minY + visible.height * 0.62
			))
		}

		alphaValue = 0
		orderFrontRegardless()
		NSAnimationContext.runAnimationGroup { context in
			context.duration = 0.2
			animator().alphaValue = 1
		}

		hideWorkItem?.cancel()
		let item = DispatchWorkItem { [weak self] in self?.hide() }
		hideWorkItem = item
		DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
	}

	func hide() {
		hideWorkItem?.cancel()
		NSAnimationContext.runAnimationGroup({ context in
			context.duration = 0.3
			self.animator().alphaValue = 0
		}, completionHandler: { [self] in onMain { self.orderOut(nil) } })
	}

	// 自检用
	var textForTest: String { label.stringValue }
}
