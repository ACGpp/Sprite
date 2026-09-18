import AppKit
import SwiftUI

/// 记录窗口：**展示工具**，不是对话入口。
///
/// 结构：左侧分区（日记 / 探索笔记 / 对话记录 / 思维流），中间条目，右侧正文。
/// 数据全部来自内核的只读接口——外壳不读记忆文件（架构原则）。
struct RecordsView: View {
	@ObservedObject var model: ShellModel

	enum Section: String, CaseIterable, Identifiable {
		/// 「现在」不是记录，是**正在发生的对话**：同一份对话流 + 输入框。
		/// 放在第一位，因为它是最常来的地方。
		case live = "现在"
		case diary = "日记"
		case explorations = "探索笔记"
		case conversations = "对话记录"
		case thoughts = "思维流"
		case voice = "语音"
		case settings = "设置"

		var id: String { rawValue }
		var symbol: String {
			switch self {
			case .live: return "bubble.left.and.text.bubble.right"
			case .diary: return "book.closed"
			case .explorations: return "safari"
			case .conversations: return "bubble.left.and.bubble.right"
			case .thoughts: return "brain"
			case .voice: return "waveform"
			case .settings: return "gearshape"
			}
		}
		var isLive: Bool { self == .live }
		var isSettings: Bool { self == .settings }
		var queryKind: String {
			switch self {
			case .live, .settings: return "conversations" // 不查询；占位以免漏分支
			case .diary: return "diary"
			case .explorations: return "explorations"
			case .conversations: return "conversations"
			case .thoughts: return "thoughts"
			case .voice: return "voice"
			}
		}
	}

	@State private var columnVisibility: NavigationSplitViewVisibility = .all
	@State private var section: Section

	/// `initialSection` / `autoSelectFirst` 只给验证用（截图时要能直接跳到语音/思维流，
	/// 也要能构造"不自动选第一条"的形态来定位渲染问题）
	init(model: ShellModel, initialSection: Section = .live, autoSelectFirst: Bool = true, initialSelection: Int = 0) {
		self.model = model
		_section = State(initialValue: initialSection)
		self.autoSelectFirst = autoSelectFirst
		self.initialSelection = initialSelection
	}

	private let autoSelectFirst: Bool
	/// 只给验证用：截图时预选第 N 条，才能验证"右栏跟不跟着选中走"
	private let initialSelection: Int
	@State private var entries: [[String: String]] = []
	/// 选中的是**第几条**，不是"哪本字典"。
	///
	/// 老实现用值相等反查条目（拿 path/at/text 去比）——聚合出来的"按天一条"
	/// 根本没有 path/at，只能靠 text 撞，于是选中态不可靠：点了别的天，右栏不换
	/// （真实反馈："无论点 16、15、14 还是 7、10，右边都不会切换"）。
	/// 下标没有这个问题。
	@State private var selectedIndex: Int?

	/// 当前选中的条目（由下标推出，避免两份状态不同步）
	private var selected: [String: String]? {
		guard let index = selectedIndex, entries.indices.contains(index) else { return nil }
		return entries[index]
	}
	@State private var document: String = ""
	/// 这份 document 属于哪一个条目（path）。异步回调回来时对不上就丢弃——
	/// 否则"看过日记 → 切到对话记录"会看到日记正文（真实反馈："我在里面发现了日记"）。
	@State private var documentPath: String = ""
	@State private var loading = false
	@State private var playbackError: String?

	var body: some View {
		NavigationSplitView(columnVisibility: $columnVisibility) {
			List(Section.allCases, selection: Binding(
				get: { section },
				set: { if let value = $0 { section = value } }
			)) { item in
				Label(item.rawValue, systemImage: item.symbol).tag(item)
			}
			.navigationSplitViewColumnWidth(min: 150, ideal: 168, max: 200)
			.listStyle(.sidebar)
		} content: {
			List(entries.indices, id: \.self, selection: $selectedIndex) { index in
				let entry = entries[index]
				VStack(alignment: .leading, spacing: 3) {
					Text(entry["title"] ?? entry["who"] ?? L("（无标题）"))
						.font(.system(size: 12.5, weight: .medium))
						.lineLimit(1)
					// 列表里**必须显示时间**——笔记正文里常常没有时间，标签由我们标上
					if let meta = metaLine(entry) {
						Text(meta).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
					}
					if let preview = entry["preview"], !preview.isEmpty {
						Text(preview).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(2)
					}
				}
				.padding(.vertical, 2)
				// **必须有 tag**：`List(selection:)` 靠它把"被点的这一行"映射回选择值。
				// 少了它，预选（截图验证那种走的是状态）能正常工作，**手点却完全没反应**——
				// 真实反馈："点 16、15、14 还是 7、10，右边都不会切换"。
				// 侧栏那份一直有 `.tag(item)`，所以侧栏能点、中栏不能。
				.tag(index)
				.contentShape(Rectangle()) // 整行可点，不只是文字
			}
			.navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
		} detail: {
			ScrollViewReader { proxy in
			ScrollView {
				VStack(alignment: .leading, spacing: 12) {
					Color.clear.frame(height: 1).id("detail-top")
					if section.isLive {
						ConversationView(model: model)
					} else if section.isSettings {
						SettingsView(model: model)
					} else if loading {
						ProgressView().controlSize(.small)
					} else if section == .voice, let selected {
						voiceDetail(selected)
					} else if !document.isEmpty {
						Text(document)
							.font(.system(size: 13))
							.textSelection(.enabled)
							.fixedSize(horizontal: false, vertical: true)
					} else if let selected {
						Text(selected["text"].flatMap { $0.isEmpty ? nil : $0 } ?? selected["preview"] ?? "（没有内容）")
							.font(.system(size: 13))
							.textSelection(.enabled)
							.fixedSize(horizontal: false, vertical: true)
					} else {
						Text(L("左边选一条看看"))
							.foregroundStyle(.tertiary)
					}
					Spacer(minLength: 0)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(20)
			}
			// 换了条目就滚回顶部：锚点 id 是**固定的**，不制造视图身份变化
			// （上一次用 `.id(selectedIndex)` 改身份，AppKit 在布局中抛异常直接崩了）
			.onChange(of: selectedIndex) { _, _ in
				withAnimation(nil) { proxy.scrollTo("detail-top", anchor: .top) }
			}
			}
		}
		.frame(minWidth: 820, minHeight: 520)
		.onAppear { if !section.isLive && !section.isSettings { reload() } }
		.onChange(of: section) { _, newValue in
			columnVisibility = newValue.isLive || newValue.isSettings ? .detailOnly : .all
			model.onLiveSectionChange?(newValue.isLive)
			if newValue.isLive || newValue.isSettings {
				selectedIndex = nil
				document = ""
				documentPath = ""
				loading = false
			} else {
				reload()
			}
		}
		.onAppear { model.onLiveSectionChange?(section.isLive) }
		.onDisappear { model.onLiveSectionChange?(false) }
		// 存了新语音 → 列表自己刷；内核重连上来 → 把空列表补上
		.onChange(of: selectedIndex) { _, _ in loadDocumentIfNeeded() }
		// 防御：列表换了一份（分区切换/重新加载）之后，旧下标可能越界。
		// SwiftUI 的 List 在"选中项不存在"时会在布局里抛异常（AppKit 把它变成崩溃，
		// 用户看到的就是转圈然后应用没了）。所以这里主动清掉。
		.onChange(of: entries.count) { _, count in
			if let index = selectedIndex, !(0..<count).contains(index) { selectedIndex = nil }
		}
		.onChange(of: model.recordsRevision) { _, _ in if section == .voice { reload() } }
		.onChange(of: model.connected) { _, connected in if connected && entries.isEmpty { reload() } }
	}

	/// 一条语音：原话能回听，转写能读。
	@ViewBuilder
	private func voiceDetail(_ entry: [String: String]) -> some View {
		let path = entry["path"] ?? ""
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 8) {
				Text(entry["title"] ?? "语音").font(.system(size: 13, weight: .medium))
				if let meta = entry["meta"], !meta.isEmpty {
					Text(meta).font(.system(size: 11)).foregroundStyle(.secondary)
				}
				Spacer()
				if !path.isEmpty {
					Button {
						model.playAudio(path: path) { problem in
							if let problem { playbackError = problem }
						}
					} label: {
						Label(model.playingPath == path ? "停止" : "播放原话", systemImage: model.playingPath == path ? "stop.fill" : "play.fill")
					}
					.buttonStyle(.bordered)
					.controlSize(.small)
					// 没有文字（设备端识别静默返回空）时，能在这里把它读出来。
					// 系统通道会把音频送到 Apple，所以写清楚，由人决定点不点。
					Button {
						// 按设置里的通道重转（默认系统通道）；要换通道请到菜单栏面板里切换
						model.retranscribe(path: path)
					} label: {
						Label(model.retranscribing ? "识别中…" : "重新转写", systemImage: "waveform.badge.magnifyingglass")
					}
					.buttonStyle(.bordered)
					.controlSize(.small)
					.disabled(model.retranscribing)
					.help(L("先用设备端识别；没听出来再走系统通道（音频会送到 Apple）"))
				}
			}
			if !path.isEmpty {
				Text(L("音频由内核保管，播放走内核读取——外壳不碰记忆目录。"))
					.font(.system(size: 10))
					.foregroundStyle(.tertiary)
			} else {
				Text(L("这条只有文字，没有音频"))
					.font(.system(size: 10))
					.foregroundStyle(.tertiary)
			}
			if let problem = playbackError {
				Text("⚠︎ \(problem)").font(.system(size: 11)).foregroundStyle(.orange)
			}
			if let note = model.retranscribeNote {
				Text(note).font(.system(size: 11)).foregroundStyle(note.contains("⚠︎") ? .orange : .secondary)
			}
			Divider()
			Text(entry["text"].flatMap { $0.isEmpty ? nil : $0 } ?? "（这段录音没有转写文字）")
				.font(.system(size: 13))
				.textSelection(.enabled)
				.fixedSize(horizontal: false, vertical: true)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// 条目副标题：日期 + 条数（按天聚合后，"一天一条"是主要信息）
	private func metaLine(_ entry: [String: String]) -> String? {
		var parts: [String] = []
		if let date = entry["date"], !date.isEmpty { parts.append(date) }
		if let count = entry["count"], let number = Int(count), number > 1 { parts.append("\(number) 条") }
		if let meta = entry["meta"], !meta.isEmpty, meta != entry["date"] { parts.append(meta) }
		if let at = entry["at"], !at.isEmpty, parts.isEmpty {
			if let date = ShellModel.parse(at) {
				let formatter = DateFormatter()
				formatter.locale = Locale(identifier: "zh_CN")
				formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
				formatter.dateFormat = "M月d日 HH:mm"
				parts.append(formatter.string(from: date))
			} else {
				parts.append(at)
			}
		}
		return parts.isEmpty ? nil : parts.joined(separator: "　·　")
	}

	private func reload() {
		loading = true
		selectedIndex = nil
		document = ""
		documentPath = ""
		let requested = section
		model.loadRecords(kind: section.queryKind) { list in
			// 回调可能来自上一次切换：只认当前分区的结果，别把旧数据画到新分区上
			guard requested == section else { return }
			entries = list
			loading = false
			// 每一类都自动选第一条：右侧永远不会是一片空白
			selectedIndex = autoSelectFirst && list.indices.contains(initialSelection) ? initialSelection : nil
			loadDocumentIfNeeded()
		}
	}

	private func loadDocumentIfNeeded() {
		// 按天聚合的条目自带全文；只有单篇文件才需要去向内核要正文
		if let text = selected?["text"], !text.isEmpty {
			document = ""
			documentPath = ""
			return
		}
		guard let path = selected?["path"], !path.isEmpty else {
			document = ""
			documentPath = ""
			return
		}
		guard path != documentPath || document.isEmpty else { return }
		document = ""
		documentPath = path
		loading = true
		model.loadDocument(path: path) { text in
			// 回来时已经不是这一条了：丢弃（这就是"对话记录里冒出日记"的成因）
			guard documentPath == path else { return }
			document = text
			loading = false
		}
	}
}
