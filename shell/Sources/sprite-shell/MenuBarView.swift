import AppKit
import Carbon.HIToolbox
import SwiftUI

/// 菜单栏下拉面板（SwiftUI）。
///
/// 这是**主要交互面**：点菜单栏图标出来，看它此刻状态、看它刚说的话、说一句、做几个快动作。
/// 之前那些"自定义卡片 + 手绘控件"的做法被废弃——原生控件本身就带层级、间距与材质，
/// 手绘只会更简陋（真实用户反馈："你到底会不会做前端"）。
struct MenuBarView: View {
	@ObservedObject var model: ShellModel
	/// 折叠/展开的诊断信息（默认收起：没事的时候不该看到技术细节）
	@State private var showDiagnostics = false
	/// 量出来的内容高度：面板高度跟着它走，收起诊断就变矮（真实用户反馈：下面空一块）
	@State private var contentHeight: CGFloat = 320

	private static let maxHeight: CGFloat = 560
	private static let minHeight: CGFloat = 180

	/// 诊断默认收起。`initialDiagnostics` 只给验证用（无头量高度时要能构造两种状态）。
	init(model: ShellModel, initialDiagnostics: Bool = false) {
		self.model = model
		_showDiagnostics = State(initialValue: initialDiagnostics)
	}

	var body: some View {
		// 高度 = 内容高度（上限 560）：够高就滚动，不够高就贴合内容，
		// 不再有"固定的空一块"。
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				statusSection
				Divider().padding(.vertical, 10)
				conversationSection
				Divider().padding(.vertical, 10)
				voiceNotesSection
				if model.isRecording || model.voiceSummary != nil || model.archiveNote != nil || model.retranscribeNote != nil {
					Divider().padding(.vertical, 10)
				}
				actionsSection
				Divider().padding(.vertical, 10)
				footerSection
			}
			.padding(14)
			.frame(maxWidth: .infinity, alignment: .leading)
			.fixedSize(horizontal: false, vertical: true)
			.background(
				GeometryReader { proxy in
					Color.clear.preference(key: PanelHeightKey.self, value: proxy.size.height)
				}
			)
		}
		.frame(width: 340, height: min(max(contentHeight, Self.minHeight), Self.maxHeight))
		.onPreferenceChange(PanelHeightKey.self) { height in
			// 半像素抖动会让 popover 一直闪，这里对齐到 1pt
			let rounded = height.rounded()
			if abs(rounded - contentHeight) > 0.5 { contentHeight = rounded }
		}
	}

	// MARK: - 它此刻

	private var statusSection: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 7) {
				Circle()
					.fill(accentColor)
					.frame(width: 8, height: 8)
				Text(model.presenceTitle)
					.font(.system(size: 14, weight: .medium))
				Spacer()
				if let runs = model.state?.runs {
					Text("第 \(runs) 次呼吸")
						.font(.system(size: 10.5))
						.foregroundStyle(.tertiary)
				}
			}
			if let activity = model.activityText {
				Text(activity)
					.font(.system(size: 11.5))
					.foregroundStyle(.secondary)
					.lineLimit(1)
			}
			Text(model.breathLine.replacingOccurrences(of: "\n", with: "　·　"))
				.font(.system(size: 11))
				.foregroundStyle(.tertiary)
				.lineLimit(2)
			// 还没配模型：直接在这里说出来，并且点一下就能去填（首次运行会自己弹配置面板）
			if let setup = model.snapshot?.setup, !setup.hasModelConfig {
				HStack(spacing: 6) {
					Image(systemName: "exclamationmark.triangle")
					Text("还没配模型——它还不会思考")
					Button("去填") { model.onOpenRecords?(.settings) }
						.buttonStyle(.link)
						.font(.system(size: 11.5))
				}
				.font(.system(size: 11.5))
				.foregroundStyle(.orange)
			}
			if let summary = model.todaySummary {
				Text(summary)
					.font(.system(size: 11.5))
					.foregroundStyle(.secondary)
					.lineLimit(1)
			}
			if let hint = model.idleHint {
				Text(hint)
					.font(.system(size: 11))
					.foregroundStyle(.orange)
			}
			if let notice = model.quietNotice {
				Text(notice)
					.font(.system(size: 11))
					.foregroundStyle(.secondary)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}

	// MARK: - 对话流（主角）

	/// 面板里显示**最近几轮**（我说的 + 它说的），而不是只有"它刚说"一句。
	/// 真实反馈：多轮对话时看不到上下文，上一轮全被覆盖掉了。
	/// 面板和记录窗口的「现在」是同一个视图、同一份数据——同一句话只有一个显示位置。
	private var conversationSection: some View {
		ConversationView(model: model, compact: true, onExpand: { model.onOpenRecords?(.live) })
			.frame(maxHeight: 190)
	}

	/// 录音的结果与补救入口（原来挂在输入行下面，现在输入行在对话流里）
	private var voiceNotesSection: some View {
		VStack(alignment: .leading, spacing: 4) {
			if model.isRecording {
				HStack(spacing: 6) {
					Circle().fill(.red).frame(width: 7, height: 7)
					Text(model.voiceStatusText.isEmpty ? "正在录…" : model.voiceStatusText)
						.font(.system(size: 10.5)).foregroundStyle(.red).lineLimit(2)
				}
				.padding(.vertical, 3).padding(.horizontal, 7)
				.background(RoundedRectangle(cornerRadius: 6).fill(Color.red.opacity(0.09)))
			}
			if let summary = model.voiceSummary, !model.isRecording {
				Text(summary)
					.font(.system(size: 10.5))
					.foregroundStyle(summary.hasPrefix("⚠︎") ? .orange : .secondary)
					.lineLimit(3)
					.fixedSize(horizontal: false, vertical: true)
			}
			if let note = model.archiveNote, !model.isRecording {
				Text(note).font(.system(size: 10))
					.foregroundStyle(note.contains("没能") || note.contains("失败") ? .orange : .secondary)
					.lineLimit(2)
			}
			if model.voiceNeedsRetry, !model.isRecording, let file = model.lastVoiceFile {
				HStack(spacing: 8) {
					Button {
						model.retranscribe(path: file, forceChannel: model.useSystemRecognition ? .onDevice : .system)
					} label: {
						Label(
							model.retranscribing ? "正在重新识别…" : (model.useSystemRecognition ? "改用设备端再试（不出机器）" : "改用系统识别（音频送 Apple）"),
							systemImage: "arrow.left.arrow.right"
						)
						.font(.system(size: 11))
					}
					.buttonStyle(.bordered).controlSize(.small).disabled(model.retranscribing)
					Button("就这样发") { model.voiceNeedsRetry = false }
						.buttonStyle(.borderless).font(.system(size: 11)).foregroundStyle(.secondary)
				}
				.padding(.vertical, 3).padding(.horizontal, 7)
				.background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.10)))
			}
			if let note = model.retranscribeNote {
				Text(note).font(.system(size: 10))
					.foregroundStyle(note.contains("⚠︎") ? .orange : .secondary).lineLimit(2)
			}
		}
	}

	// MARK: - 快动作

	private var actionsSection: some View {
		VStack(alignment: .leading, spacing: 2) {
			actionRow("现在叫醒它", symbol: "sun.max") { model.wakeNow() }
			Menu {
				Button("安静一小时") { model.pause(until: "hour") }
				Button("今晚别出声") { model.pause(until: "tonight") }
				Button("直到我说继续") { model.pause(until: "manual") }
			} label: {
				Label(model.isPaused ? "继续呼吸" : "暂停呼吸", systemImage: model.isPaused ? "play" : "moon.zzz")
			}
			.menuStyle(.borderlessButton)
			Toggle(isOn: Binding(
				get: { model.speakAloud },
				set: { model.speakAloud = $0 }
			)) {
				Text(model.speakAloud ? "出声：开（在家模式）" : "出声：关（办公模式）")
					.font(.system(size: 12.5))
			}
			.toggleStyle(.switch)
			.controlSize(.small)
			// 识别通道：默认系统通道（设备端在这台机器上会静默丢内容），代价写在脸上
			Toggle(isOn: Binding(
				get: { model.useSystemRecognition },
				set: { model.useSystemRecognition = $0 }
			)) {
				Text(model.useSystemRecognition ? "识别：系统通道（更准，音频送到 Apple）" : "识别：设备端（不出这台机器）")
					.font(.system(size: 12.5))
			}
			.toggleStyle(.switch)
			.controlSize(.small)
			actionRow("打开它的记录…", symbol: "book") { model.onOpenRecords?(.live) }
			actionRow("设置…（模型 / 安静时段 / 主动说话）", symbol: "gearshape") { model.onOpenRecords?(.settings) }
		}
	}

	private func actionRow(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Label(title, systemImage: symbol)
				.font(.system(size: 12.5))
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.buttonStyle(.borderless)
	}

	// MARK: - 底部

	private var footerSection: some View {
		VStack(alignment: .leading, spacing: 6) {
			if let problem = model.connectionError {
				Text("⚠︎ \(problem)")
					.font(.system(size: 11))
					.foregroundStyle(.orange)
					.fixedSize(horizontal: false, vertical: true)
			}
			HStack {
				Button(showDiagnostics ? "收起诊断" : "诊断…") { showDiagnostics.toggle() }
					.buttonStyle(.borderless)
					.font(.system(size: 11))
					.foregroundStyle(.secondary)
				Spacer()
				Button("退出") { NSApp.terminate(nil) }
					.buttonStyle(.borderless)
					.font(.system(size: 11))
					.foregroundStyle(.secondary)
			}
			if showDiagnostics {
				Text(model.diagnosticsText)
					.font(.system(size: 10, design: .monospaced))
					.foregroundStyle(.tertiary)
					.fixedSize(horizontal: false, vertical: true)
					.textSelection(.enabled)
			}
		}
	}

}

/// 内容高度上报（面板高度跟着内容走）
private struct PanelHeightKey: PreferenceKey {
	static let defaultValue: CGFloat = 0
	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
		value = max(value, nextValue())
	}
}

extension MenuBarView {
	private var accentColor: Color {
		switch model.state?.presence {
		case .thinking: return Color(red: 0.73, green: 0.63, blue: 0.85)
		case .quiet: return Color(red: 0.42, green: 0.50, blue: 0.49)
		case .paused: return Color.secondary
		case .degraded: return Color(red: 0.84, green: 0.72, blue: 0.43)
		default: return Color(red: 0.47, green: 0.78, blue: 0.74)
		}
	}
}
