import AppKit
import SwiftUI

/// 对话流：我说的 + 它说的。
///
/// 面板（紧凑）和记录窗口的「现在」（完整）用的是**同一个视图、同一份数据**——
/// 同一句话只在一个地方出现。真实用户反馈的"他回我的时候还会弹一个弹窗，
/// 但其实他在面板上已经回复我了"，根子就是同一句话有两个投影。
struct ConversationView: View {
	@ObservedObject var model: ShellModel
	/// 紧凑模式：面板里只显示最近几轮，字号小一点
	var compact: Bool = false
	/// 面板里的「展开到窗口」
	var onExpand: (() -> Void)?

	@State private var atBottom = true
	@FocusState private var inputFocused: Bool

	/// 紧凑模式显示最近几轮（面板空间有限）；窗口里全给
	private var visibleTurns: [ShellModel.Turn] {
		let all = model.liveConversation
		return compact ? Array(all.suffix(4)) : all
	}

	var body: some View {
		VStack(alignment: .leading, spacing: compact ? 6 : 10) {
			header
			thread
			inputRow
		}
	}

	// MARK: - 标题行

	@ViewBuilder
	private var header: some View {
		HStack(spacing: 6) {
			if !compact {
				Text("现在").font(.system(size: 13, weight: .medium))
				if let name = model.companionName {
					Text("和 \(name) 说话").font(.system(size: 11)).foregroundStyle(.secondary)
				}
			} else {
				Text("对话").font(.system(size: 10, weight: .medium)).foregroundStyle(.tertiary)
			}
			Spacer()
			if let onExpand, compact {
				Button("展开") { onExpand() }
					.buttonStyle(.borderless)
					.font(.system(size: 11))
					.foregroundStyle(.secondary)
			}
		}
		// 记录窗口（完整视图）里显示"它今天做了什么"：要不要做事是它的选择，
		// 但用户有权看见它有没有在生活——不用靠"它说没说话"猜。
		if !compact {
			HStack(spacing: 8) {
				if let summary = model.todaySummary {
					Text(summary).font(.system(size: 11.5)).foregroundStyle(.secondary)
				}
				if let hint = model.idleHint {
					Text(hint).font(.system(size: 11)).foregroundStyle(.orange)
				}
				Spacer()
			}
		}
	}

	// MARK: - 对话本体

	private var thread: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: compact ? 6 : 10) {
					if visibleTurns.isEmpty {
						VStack(alignment: .leading, spacing: 3) {
							Text(model.connected ? "还没有新对话。说一句试试。" : "还没连上内核（它是唯一的事实来源）")
								.font(.system(size: compact ? 11 : 12.5))
								.foregroundStyle(.tertiary)
							if model.archivedTurnCount > 0 {
								Text("更早的 \(model.archivedTurnCount) 条在「对话记录」里")
									.font(.system(size: compact ? 10 : 11))
									.foregroundStyle(.tertiary)
							}
						}
						.padding(.vertical, 6)
					} else if model.archivedTurnCount > 0 {
						Text("更早的 \(model.archivedTurnCount) 条旧对话在「对话记录」里")
							.font(.system(size: compact ? 10 : 11))
							.foregroundStyle(.tertiary)
					}
					ForEach(visibleTurns) { turn in
						bubble(turn).id(turn.id)
					}
					if model.isThinking {
						thinkingRow.id("thinking")
					}
				}
				.padding(.vertical, 2)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.modifier(BottomTracker(atBottom: $atBottom))
			// 只有你本来就在底部时才自动滚动——不然会把你正在看的地方拽走（真实反馈）
			.onChange(of: model.conversation.count) { _, _ in
				guard atBottom, let last = visibleTurns.last else { return }
				withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(last.id, anchor: .bottom) }
			}
			.onChange(of: model.isThinking) { _, thinking in
				guard thinking, atBottom else { return }
				withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("thinking", anchor: .bottom) }
			}
			.onAppear {
				if let last = visibleTurns.last { proxy.scrollTo(last.id, anchor: .bottom) }
			}
		}
	}

	@ViewBuilder
	private func bubble(_ turn: ShellModel.Turn) -> some View {
		VStack(alignment: turn.fromMe ? .trailing : .leading, spacing: 2) {
			HStack(spacing: 5) {
				Text(turn.fromMe ? "我" : (model.companionName ?? "它"))
					.font(.system(size: 10))
					.foregroundStyle(.tertiary)
				if !turn.at.isEmpty, let date = ShellModel.parse(turn.at) {
					Text(Self.clock.string(from: date))
						.font(.system(size: 10))
						.foregroundStyle(.tertiary)
				}
				if turn.imported {
					Text("旧记录").font(.system(size: 9.5)).foregroundStyle(.tertiary)
				}
				if turn.heldBack {
					// 安静时段收着的：让它可见，并说明它当时为什么没弹出来
					Text("安静时段收着的").font(.system(size: 9.5)).foregroundStyle(.tertiary)
				}
			}
			Text(turn.text)
				.font(.system(size: compact ? 12 : 13))
				.textSelection(.enabled)
				.fixedSize(horizontal: false, vertical: true)
				.padding(.vertical, compact ? 5 : 7)
				.padding(.horizontal, compact ? 8 : 10)
				.background(
					RoundedRectangle(cornerRadius: 8)
						.fill(turn.fromMe ? Color.accentColor.opacity(turn.pending ? 0.12 : 0.24) : Color.primary.opacity(0.10))
				)
				// 两侧不只是靠对齐区分：我的有描边，它的是实底（真实反馈："有点不明显"）
				.overlay(
					RoundedRectangle(cornerRadius: 8)
						.stroke(turn.fromMe ? Color.accentColor.opacity(0.45) : Color.clear, lineWidth: 1)
				)
				.opacity(turn.pending ? 0.65 : 1)
		}
		.frame(maxWidth: .infinity, alignment: turn.fromMe ? .trailing : .leading)
	}

	/// 等待感：它想事情可能要几十秒，界面必须说出来（真实反馈：不知道它到底在不在动）
	private var thinkingRow: some View {
		HStack(spacing: 6) {
			ProgressView().controlSize(.small)
			Text("它在想…已经 \(model.thinkingSeconds) 秒")
				.font(.system(size: compact ? 11 : 12))
				.foregroundStyle(.secondary)
			if let activity = model.activityText {
				Text("· \(activity)").font(.system(size: compact ? 10 : 11)).foregroundStyle(.tertiary)
			}
		}
		.padding(.leading, 2)
	}

	// MARK: - 输入

	private var inputRow: some View {
		HStack(spacing: 8) {
			// 草稿住在模型里：面板和窗口共享，切来切去不会丢
			TextField("跟它说一句…", text: $model.draft)
				.textFieldStyle(.roundedBorder)
				.focused($inputFocused)
				.onSubmit(send)
			Button {
				model.onToggleRecording?()
			} label: {
				Image(systemName: model.isRecording ? "stop.circle.fill" : "mic.fill")
					.foregroundStyle(model.isRecording ? .red : .secondary)
			}
			.buttonStyle(.borderless)
			.help(model.isRecording ? "停止并转写" : "点一下开始录音，再点一下停止并转写")
			Button("送出", action: send)
				.buttonStyle(.borderedProminent)
				.disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
		}
		.onChange(of: model.focusInputToken) { _, _ in inputFocused = true }
		.onAppear { if !compact { inputFocused = true } }
	}

	private func send() {
		let text = model.draft
		guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
		if model.sendMessage(text) {
			model.draft = ""
			// 发完光标留在输入框里：多轮对话不该每次都要再点一下
			inputFocused = true
		}
	}

	private static let clock: DateFormatter = {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "zh_CN")
		formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
		formatter.dateFormat = "HH:mm"
		return formatter
	}()
}

/// 跟踪"你是不是已经在底部"。
///
/// macOS 15 起用 `onScrollGeometryChange` 精确判断；旧系统上不启用自动滚动跟踪
/// （宁可不滚，也不把你正在看的地方拽走）。
private struct BottomTracker: ViewModifier {
	@Binding var atBottom: Bool

	func body(content: Content) -> some View {
		if #available(macOS 15.0, *) {
			content.onScrollGeometryChange(for: Bool.self) { geometry in
				geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 24
			} action: { _, value in
				if atBottom != value { atBottom = value }
			}
		} else {
			content
		}
	}
}
