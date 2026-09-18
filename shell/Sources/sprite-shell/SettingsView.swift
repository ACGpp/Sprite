import AppKit
import SwiftUI

/// 设置表单：模型、安静时段、主动说话。
///
/// 存在的理由很直接：以前配模型要用户自己新建配置文件并手写
/// `PI_PROVIDER=... PI_API_KEY=...`——对不懂 AI、不懂命令行的人是道墙。
/// 现在在界面上选、填、按保存就行；密钥由内核 0600 存好，**存进去就不再回显**。
///
/// 记录窗口的「设置」页和首次运行引导用的是**同一个视图**。
struct SettingsView: View {
	@ObservedObject var model: ShellModel
	/// 紧凑模式（首次运行的面板里用）
	var compact: Bool = false

	@State private var mode = "provider"
	@State private var provider = "deepseek"
	@State private var modelId = ""
	@State private var apiFormat = "openai-completions"
	@State private var baseUrl = ""
	@State private var modelName = ""
	@State private var apiKey = ""
	@State private var quietStart = 23
	@State private var quietEnd = 7
	@State private var proactiveEnabled = true
	@State private var proactivePerDay = 2
	@State private var loaded = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: compact ? 12 : 16) {
				if !compact {
					Text(L("设置")).font(.system(size: 15, weight: .medium))
					Text(L("改完按「保存并应用」。模型换了内核会**当场换一次思考引擎**，不用重启应用。"))
						.font(.system(size: 11.5)).foregroundStyle(.secondary)
				}

				languageSection
				Divider()
				modelSection
				Divider()
				shellSection
				Divider()
				startupSection
				Divider()
				quietSection
				Divider()
				proactiveSection
				Divider()
				saveSection

				if !compact {
					Divider()
					honestNotes
				}
			}
			.padding(compact ? 16 : 24)
			.frame(maxWidth: compact ? 460 : 560, alignment: .leading)
		}
		.onAppear {
			model.loadSettings()
			applyLoaded()
		}
		.onChange(of: model.settings.map { "\($0.mode)|\($0.provider ?? "")|\($0.model ?? "")|\($0.apiFormat ?? "")|\($0.baseUrl ?? "")|\($0.quietStart)|\($0.quietEnd)|\($0.proactiveEnabled)|\($0.proactivePerDay)|\($0.hasApiKey)" }) { _, _ in
			applyLoaded()
		}
	}

	/// 内核的值 → 表单（只在第一次、或保存后被内核确认过才覆盖，避免打字被打断）
	private func applyLoaded() {
		guard let settings = model.settings else { return }
		guard !loaded || model.settingsNote != nil else { return }
		mode = settings.mode
		provider = settings.provider ?? settings.providers.first?.id ?? "deepseek"
		modelId = settings.model ?? ""
		apiFormat = settings.apiFormat ?? "openai-completions"
		baseUrl = settings.baseUrl ?? ""
		modelName = settings.modelName ?? ""
		quietStart = settings.quietStart
		quietEnd = settings.quietEnd
		proactiveEnabled = settings.proactiveEnabled
		proactivePerDay = settings.proactivePerDay
		loaded = true
	}

	// MARK: - 模型

	/// 界面语言：跟随系统 / 中文 / English。
	/// 单独一节放在最前面——它是"你能不能看懂这个界面"的前提。
	private var languageSection: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(L("界面语言")).font(.system(size: 13, weight: .medium))
			Picker("", selection: $model.uiLanguage) {
				ForEach(UILanguage.allCases, id: \.self) { language in
					Text(language.label).tag(language)
				}
			}
			.labelsHidden()
			// 固定尺寸 + 默认（下拉）样式：segmented 在 macOS 上尺寸敏感，
			// 而它所在的窗口刚刚因为布局循环卡死过一次——不给自己找麻烦。
			.fixedSize()
			Text(L("默认跟随系统语言；没翻译到的文案会回落中文。"))
				.font(.system(size: 11)).foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	private var modelSection: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(L("模型")).font(.system(size: 13, weight: .medium))
			Picker(L("用哪家"), selection: $mode) {
				Text(L("内置供应商（只填 Key）")).tag("provider")
				Text(L("自定义地址（OpenAI 格式等）")).tag("custom")
			}
			.pickerStyle(.segmented)
			.labelsHidden()
			.frame(maxWidth: 380)

			if mode == "provider" {
				Picker(L("供应商"), selection: $provider) {
					ForEach(model.settings?.providers ?? [], id: \.id) { item in
						Text(item.label + (item.hint.isEmpty ? "" : "　—　\(item.hint)")).tag(item.id)
					}
				}
				.frame(maxWidth: 460)
				HStack(spacing: 8) {
					if !model.availableModels.isEmpty {
						Picker(L("模型"), selection: $modelId) {
							Text(L("（选一个）")).tag("")
							// 当前正在用的模型即使不在清单里也要留着，
							// 否则打开设置就会把它悄悄改掉（deepseek-chat 就不在官方清单里）
							if !modelId.isEmpty, !model.availableModels.contains(where: { $0.id == modelId }) {
								Text(Lf("%@（正在用，不在清单里）", modelId)).tag(modelId)
							}
							ForEach(model.availableModels, id: \.id) { item in
								Text(item.note.isEmpty ? item.id : "\(item.id)　—　\(item.note)").tag(item.id)
							}
						}
						.frame(maxWidth: 420)
					} else {
						TextField(L("模型 ID（例如 deepseek-chat）"), text: $modelId)
							.textFieldStyle(.roundedBorder)
							.frame(maxWidth: 320)
					}
					Button(model.loadingModels ? L("读取中…") : L("读取可选模型（实时）")) { model.loadModels(provider: provider) }
						.buttonStyle(.bordered)
						.controlSize(.small)
						.disabled(model.loadingModels)
				}
				if let note = model.modelsNote {
					Text(note).font(.system(size: 10.5)).foregroundStyle(.tertiary)
				}
			} else {
				Picker(L("接口格式"), selection: $apiFormat) {
					ForEach(model.settings?.apiFormats ?? [], id: \.id) { item in
						Text(item.label).tag(item.id)
					}
				}
				.frame(maxWidth: 460)
				TextField(L("服务地址（http:// 或 https:// 开头，例如 https://api.example.com/v1）"), text: $baseUrl)
					.textFieldStyle(.roundedBorder)
				HStack(spacing: 8) {
					TextField(L("模型名（例如 gpt-4o-mini）"), text: $modelId)
						.textFieldStyle(.roundedBorder)
						.frame(maxWidth: 220)
					TextField("显示名（可留空）", text: $modelName)
						.textFieldStyle(.roundedBorder)
						.frame(maxWidth: 200)
				}
			}

			HStack(spacing: 8) {
				SecureField(model.settings?.hasApiKey == true ? "API Key（已保存，留空表示不改）" : "API Key", text: $apiKey)
					.textFieldStyle(.roundedBorder)
					.frame(maxWidth: 320)
				if model.settings?.hasApiKey == true {
					Label(L("已配置"), systemImage: "checkmark.seal")
						.font(.system(size: 11))
						.foregroundStyle(.secondary)
				}
			}
			Text(L("密钥由内核保存在本机（文件权限 0600），**保存后不会再显示出来**；它只会传给思考引擎，不进日志、不进界面。"))
				.font(.system(size: 10.5))
				.foregroundStyle(.tertiary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	// MARK: - 它的手脚（可选边界）

	@State private var agentShell = "on"

	private var shellSection: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(L("它的手脚")).font(.system(size: 13, weight: .medium))
			Picker("档位", selection: Binding(
				get: { agentShell },
				set: { agentShell = $0 }
			)) {
				Text(L("全开（能跑命令、能读写文件）")).tag("on")
				Text(L("只读（能看能搜，不能改、不能跑命令）")).tag("readonly")
				Text(L("只剩说话（不能碰文件）")).tag("off")
			}
			.labelsHidden()
			.frame(maxWidth: 420)
			Text(agentShellHint)
				.font(.system(size: 10.5))
				.foregroundStyle(.tertiary)
				.fixedSize(horizontal: false, vertical: true)
		}
		.onAppear { agentShell = model.settings?.agentShell ?? "on" }
	}

	private var agentShellHint: String {
		switch agentShell {
		case "readonly":
			return L("它能读文件、搜索，但不能写、不能跑命令。想说话/留话/改作息仍然可以（那些走内核的能力请求）。")
		case "off":
			return L("它只能说话、留话、决定下次什么时候醒、向你提问——完全碰不到文件与命令。最安全，但它也就不能自己去看世界、写笔记了。")
		default:
			return L("它有手有脚：能跑命令、能读写文件（写入限制在日记/探索/笔记/私人空间/工作记忆里）。**请知道：命令不是沙箱**——同一个用户下的进程能读到的东西它也能读到（比如它自己的密钥文件）。要真边界就选「只读」或「只剩说话」，或者给它单独的用户账号。")
		}
	}

	// MARK: - 开机就在

	@State private var loginItemOn = false
	@State private var loginItemNote: String?
	@State private var kernelService = false

	private var startupSection: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(L("开机就在")).font(.system(size: 13, weight: .medium))
			HStack(spacing: 8) {
				Toggle("登录时自动打开它", isOn: Binding(
					get: { loginItemOn },
					set: { wanted in
						let (status, problem) = LoginItem.setEnabled(wanted)
						loginItemOn = status.isOn || status == .requiresApproval
						loginItemNote = problem.map { "⚠︎ 设置失败：\($0)" } ?? status.describe
					}
				))
				.toggleStyle(.switch)
				.controlSize(.small)
			}
			if let loginItemNote {
				Text(loginItemNote)
					.font(.system(size: 11))
					.foregroundStyle(loginItemNote.hasPrefix("⚠︎") ? Color.orange : Color.secondary)
			}
			Text(kernelService
				? "内核已交给 launchd 常驻（崩溃会自动拉起）"
				: "内核还没装成常驻服务：跑一次 Scripts/install.sh 就会装好")
				.font(.system(size: 11))
				.foregroundStyle(kernelService ? Color.secondary : Color.orange)
			Text(L("登录项在「系统设置 → 通用 → 登录项」里，你随时能自己关掉。"))
				.font(.system(size: 10.5))
				.foregroundStyle(.tertiary)
		}
		.onAppear {
			let status = LoginItem.status()
			loginItemOn = status.isOn || status == .requiresApproval
			loginItemNote = status.describe
			kernelService = LoginItem.kernelServiceInstalled()
		}
	}

	// MARK: - 安静时段

	private var quietSection: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(L("安静时段（它不出声，留言照收）")).font(.system(size: 13, weight: .medium))
			HStack(spacing: 6) {
				Picker("", selection: $quietStart) {
					ForEach(0..<24, id: \.self) { Text(String(format: "%02d:00", $0)).tag($0) }
				}
				.labelsHidden()
				.frame(width: 90)
				Text(L("到")).foregroundStyle(.secondary)
				Picker("", selection: $quietEnd) {
					ForEach(0..<24, id: \.self) { Text(String(format: "%02d:00", $0)).tag($0) }
				}
				.labelsHidden()
				.frame(width: 90)
				if quietStart == quietEnd {
					Text(L("（起止相同＝关闭安静时段）")).font(.system(size: 11)).foregroundStyle(.tertiary)
				}
			}
			Text(L("安静时段里你发的消息不会丢：它们排着队，等它醒来就看到。急着说可以点面板上的「现在叫醒它」。"))
				.font(.system(size: 10.5))
				.foregroundStyle(.tertiary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	// MARK: - 主动说话

	private var proactiveSection: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(L("它主动找你")).font(.system(size: 13, weight: .medium))
			Toggle("允许它主动说一句（不是每次都回话，也不是刷存在感）", isOn: $proactiveEnabled)
				.toggleStyle(.switch)
				.controlSize(.small)
			HStack(spacing: 6) {
				Text(L("每天最多")).font(.system(size: 12))
				Stepper(value: $proactivePerDay, in: 0...999) {
					Text(Lf("%d 次", proactivePerDay)).font(.system(size: 12, design: .monospaced))
				}
				.frame(width: 170)
			}
			.disabled(!proactiveEnabled)
			Text(L("想让它多说就调大（0–999，0 = 不主动说话）。这只是防刷屏的安全阀，真正的约束是安静时段——那段时间它永远不弹窗。"))
				.font(.system(size: 10.5))
				.foregroundStyle(.tertiary)
				.fixedSize(horizontal: false, vertical: true)
			Text(L("额度是**内核**在管：超了的话它说的话会记成留言（记录里看得到），但不会弹到你眼前；安静时段永远不弹。"))
				.font(.system(size: 10.5))
				.foregroundStyle(.tertiary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	// MARK: - 保存

	private var saveSection: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 10) {
				Button(model.settingsSaving ? "正在保存…" : "保存并应用") { save() }
					.buttonStyle(.borderedProminent)
					.disabled(model.settingsSaving)
				if let note = model.settingsNote {
					Text(note)
						.font(.system(size: 11.5))
						.foregroundStyle(note.hasPrefix("保存失败") ? Color.orange : Color.secondary)
						.fixedSize(horizontal: false, vertical: true)
				}
			}
		}
	}

	private func save() {
		guard let current = model.settings else {
			model.settingsNote = "还没读到内核的设置，先等等再保存"
			return
		}
		var patch: [String: Any] = [:]

		// **只提交真正改动过的字段**：上次的教训是"只想换模型，却把主动上限一起写成了旧表单里的值"。
		// 保存不该顺手改别的设置。
		var modelPatch: [String: Any] = [:]
		if mode != current.mode { modelPatch["mode"] = mode }
		if mode == "custom" {
			if baseUrl != (current.baseUrl ?? "") { modelPatch["baseUrl"] = baseUrl }
			if modelId != (current.model ?? "") { modelPatch["model"] = modelId }
			if apiFormat != (current.apiFormat ?? "openai-completions") { modelPatch["apiFormat"] = apiFormat }
			if modelName != (current.modelName ?? "") { modelPatch["modelName"] = modelName }
		} else {
			if provider != (current.provider ?? "") { modelPatch["provider"] = provider }
			if modelId != (current.model ?? "") { modelPatch["model"] = modelId }
		}
		if !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			modelPatch["apiKey"] = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
		}
		if !modelPatch.isEmpty { patch["model"] = modelPatch }

		if quietStart != current.quietStart || quietEnd != current.quietEnd {
			patch["quietHours"] = ["start": quietStart, "end": quietEnd]
		}
		if proactiveEnabled != current.proactiveEnabled || proactivePerDay != current.proactivePerDay {
			patch["proactive"] = ["enabled": proactiveEnabled, "perDay": proactivePerDay]
		}
		if agentShell != current.agentShell {
			patch["security"] = ["agentShell": agentShell]
		}

		guard !patch.isEmpty else {
			model.settingsNote = "没有改动（没有要向内核提交的东西）"
			return
		}
		model.saveSettings(patch) { ok in
			if ok { apiKey = "" }
		}
	}

	// MARK: - 如实说明

	private var honestNotes: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(L("去哪儿找这些值")).font(.system(size: 12, weight: .medium))
			Text(L("· DeepSeek：platform.deepseek.com → API Keys；模型填 deepseek-chat\n· 中转/自建（OpenAI 格式）：选「自定义地址」，填服务商给的 base_url 与模型名\n· Claude / OpenAI / Gemini：需要能连外网"))
				.font(.system(size: 11))
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
			if let settings = model.settings {
				Text(Lf("设置文件：%@（来源：%@）", ShellModel.tilde(settings.settingsPath), settings.source))
					.help(L("路径按你这台电脑的实际位置显示（内核读的是当前用户的家目录），界面上缩成 ~ 以免泄露用户名"))
					.font(.system(size: 10.5, design: .monospaced))
					.foregroundStyle(.tertiary)
					.textSelection(.enabled)
				Text(settings.piAvailable ? "思考引擎：在跑" : "思考引擎：没在跑（检查模型与密钥）")
					.font(.system(size: 11))
					.foregroundStyle(settings.piAvailable ? Color.secondary : Color.orange)
			}
		}
	}
}
