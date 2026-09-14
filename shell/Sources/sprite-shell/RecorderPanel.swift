import AppKit
import SwiftUI

/// 录音时的浮层。
///
/// 为什么不把它做成菜单栏上的下拉面板（NSPopover）：
/// **一开麦克风，macOS 会往菜单栏插入它自己的麦克风标识**（"麦克风模式"那一条）。
/// 菜单栏空间不够时（有刘海的机器尤其明显），我们这个图标会被挤到刘海底下，
/// 挂在它上面的 popover 随即失去锚点、自己收回去——真实用户反馈就是这个：
/// "面板又收缩了，上面又变成了那个麦克风"。
///
/// 录音的界面不能依赖一个**可能被系统挤掉**的图标。所以它是一块独立的浮层：
/// 位置固定、可以拖着走、不抢焦点，图标在不在都看得见、点得到。
/// 主线程隔离：它建 NSPanel、摆位置、响应按钮——全是 AppKit。
@MainActor
public final class RecorderPanelController {
	private let model: ShellModel
	private var panel: NSPanel?
	private var hosting: NSHostingView<RecorderView>?

	public var onStop: (() -> Void)?
	public var onCancel: (() -> Void)?

	private static let size = NSSize(width: 430, height: 104)

	public init(model: ShellModel) {
		self.model = model
	}

	public var isVisible: Bool {
		panel?.isVisible ?? false
	}

	/// 自检用：浮层必须是"不抢焦点"的，否则它会打断用户正在做的事
	public var isNonActivating: Bool {
		panel.map { $0.styleMask.contains(.nonactivatingPanel) } ?? false
	}

	public func show() {
		if panel == nil { build() }
		guard let panel else { return }
		position(panel)
		// 不上屏抢焦点：orderFrontRegardless 不会激活 App，也不会抢走系统弹窗的键盘焦点
		panel.orderFrontRegardless()
	}

	public func hide() {
		panel?.orderOut(nil)
	}

	private func build() {
		let view = RecorderView(
			model: model,
			onStop: { [weak self] in self?.onStop?() },
			onCancel: { [weak self] in self?.onCancel?() }
		)
		let hosting = NSHostingView(rootView: view)
		hosting.frame = NSRect(origin: .zero, size: Self.size)
		let panel = NSPanel(
			contentRect: NSRect(origin: .zero, size: Self.size),
			styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		panel.contentView = hosting
		panel.isOpaque = false
		panel.backgroundColor = .clear
		panel.hasShadow = true
		panel.level = .floating
		panel.isMovableByWindowBackground = true // 挡住东西就自己拖开
		panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
		panel.hidesOnDeactivate = false
		panel.isReleasedWhenClosed = false
		self.hosting = hosting
		self.panel = panel
	}

	/// 屏幕水平居中、贴着菜单栏下方。系统权限弹窗在屏幕正中，
	/// 而权限弹窗出现时**还没有开始录音**（浮层不会同时出现），所以不会互相挡。
	private func position(_ panel: NSPanel) {
		guard let screen = NSScreen.main else { return }
		let frame = screen.visibleFrame
		let origin = NSPoint(
			x: frame.midX - Self.size.width / 2,
			y: frame.maxY - Self.size.height - 12
		)
		panel.setFrameOrigin(origin)
	}
}

/// 浮层内容：正在录多久、听到了什么、怎么停。
struct RecorderView: View {
	@ObservedObject var model: ShellModel
	var onStop: () -> Void
	var onCancel: () -> Void

	@State private var pulse = false

	var body: some View {
		HStack(alignment: .center, spacing: 12) {
			ZStack {
				Circle()
					.fill(Color.red.opacity(pulse ? 0.25 : 0.55))
					.frame(width: 22, height: 22)
				Circle()
					.fill(Color.red)
					.frame(width: 11, height: 11)
			}
			.onAppear {
				withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { pulse = true }
			}

			VStack(alignment: .leading, spacing: 3) {
				HStack(spacing: 6) {
					Text(model.voicePhase == "transcribing" ? "正在转写…" : "正在录音")
						.font(.system(size: 13, weight: .medium))
					Text(model.recordingElapsed)
						.font(.system(size: 12, design: .monospaced))
						.foregroundStyle(.secondary)
					// 声音从哪个麦克风进来——真实用户反馈里最要命的一句是
					// "让我选择这个麦克风模式"，他不知道自己用的是哪个输入
					if let device = AudioInput.currentDeviceName() {
						Text("· \(device)")
							.font(.system(size: 11))
							.foregroundStyle(.tertiary)
							.lineLimit(1)
					}
				}
				Text(liveLine)
					.font(.system(size: 11.5))
					.foregroundStyle(.secondary)
					.lineLimit(2)
					.fixedSize(horizontal: false, vertical: true)
			}
			Spacer(minLength: 6)
			if model.voicePhase == "transcribing" {
				ProgressView().controlSize(.small)
			} else {
				Button("停止并转写", action: onStop)
					.buttonStyle(.borderedProminent)
					.controlSize(.regular)
			}
			Button("取消", action: onCancel)
				.buttonStyle(.borderless)
				.font(.system(size: 12))
				.foregroundStyle(.secondary)
		}
		.padding(14)
		.frame(width: 430, height: 104)
		.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
		.overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.red.opacity(0.35), lineWidth: 1))
	}

	/// 实时转写：让人**看见它在听**——真实用户反馈"我不知道它到底有没有录进去"
	private var liveLine: String {
		if model.voicePhase == "transcribing" { return "已经把听到的送去识别，稍等一下" }
		let live = model.recordingLiveText.trimmingCharacters(in: .whitespacesAndNewlines)
		if live.isEmpty { return "在听…（说话就行，说完点「停止并转写」）" }
		return live
	}
}
