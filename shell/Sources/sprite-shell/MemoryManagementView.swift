import SwiftUI
import SpriteRPC

struct MemoryManagementView: View {
	@ObservedObject var model: ShellModel
	@StateObject private var memory: MemoryManagementModel
	@State private var tab = "files"
	@State private var selectedVersion: String?
	@State private var confirmingRestore = false
	@State private var addingAgreement = false
	@State private var agreementToChange: AgreementConfirmation?

	init(model: ShellModel) {
		self.model = model
		_memory = StateObject(wrappedValue: MemoryManagementModel(request: model.manageMemory))
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			HStack {
				Text(L("记忆")).font(.title2.bold())
				Spacer()
				Button { memory.refresh() } label: { Label(L("刷新"), systemImage: "arrow.clockwise") }
					.disabled(memory.saving)
			}
			Text(L("身份由它自主形成和维护。这里可以查看记忆和历史，或管理你确认的长期约定。"))
				.font(.callout).foregroundStyle(.secondary)
			Picker(L("记忆分类"), selection: $tab) {
				Text(L("文件与版本")).tag("files")
				Text(L("长期约定")).tag("agreements")
			}.pickerStyle(.segmented).disabled(memory.saving)
			if !model.connected {
				Label(L("内核未连接，请连接后重试"), systemImage: "wifi.slash").foregroundStyle(.orange)
			}
			if let error = memory.mutationError {
				VStack(alignment: .leading, spacing: 8) {
					Text(error).foregroundStyle(.orange).textSelection(.enabled)
					Text(L("若内容已被更新，请刷新后重新预览和确认；重试会沿用上一次决定，不覆盖新变化。"))
						.font(.caption).foregroundStyle(.secondary)
					Button(L("重试上次操作")) { memory.retryMutation() }.disabled(memory.saving)
				}.padding(12).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
			}
			if memory.saving { ProgressView(L("正在保存…")).controlSize(.small) }
			if let notice = memory.notice { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.green) }
			if tab == "files" { fileBrowser } else { agreementsBrowser }
		}
		.padding(20)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.onAppear { memory.refresh() }
		.onChange(of: model.connected) { _, connected in if connected { memory.refreshAfterReconnect() } }
		.onChange(of: memory.selectedPath) { _, _ in selectedVersion = nil }
		.onChange(of: memory.current?.version) { _, _ in selectedVersion = nil }
		.sheet(isPresented: $confirmingRestore) { restoreConfirmation }
		.sheet(isPresented: $addingAgreement) {
			NewAgreementView { text, kind, active, expiresAt in
				memory.addAgreement(text: text, kind: kind, active: active, expiresAt: expiresAt)
			}
		}
		.sheet(item: $agreementToChange) { confirmation in
			VStack(alignment: .leading, spacing: 16) {
				Text(L(confirmation.title)).font(.headline)
				ScrollView { Text(confirmation.agreement.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 240)
				Text(L(confirmation.explanation))
					.font(.callout).foregroundStyle(.secondary)
				HStack { Spacer(); Button(L("取消")) { agreementToChange = nil }
					Button(L(confirmation.buttonTitle)) {
						memory.changeAgreement(confirmation.agreement, activate: confirmation.activating); agreementToChange = nil
					}.buttonStyle(.borderedProminent)
				}
			}.padding(24).frame(width: 500)
		}
	}

	private var fileBrowser: some View {
		HStack(alignment: .top, spacing: 16) {
			VStack(alignment: .leading, spacing: 8) {
				Text(L("记忆文件")).font(.headline)
				if memory.loadingFiles { ProgressView().controlSize(.small) }
				if let error = memory.filesError { errorView(error) { memory.loadFiles() } }
				if memory.files.isEmpty && !memory.loadingFiles && memory.filesError == nil {
					Text(L("还没有记忆文件")).foregroundStyle(.secondary)
				}
				ScrollView {
					LazyVStack(alignment: .leading, spacing: 4) {
						ForEach(memory.files) { file in
							Button {
								selectedVersion = nil; memory.selectFile(file.path)
							} label: {
								VStack(alignment: .leading, spacing: 3) {
									Text(file.path).font(.callout).lineLimit(2).multilineTextAlignment(.leading)
									Text(file.version == "missing" ? L("当前文件不存在") : ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
								}.frame(maxWidth: .infinity, alignment: .leading).padding(8)
									.background(memory.selectedPath == file.path ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
							}.buttonStyle(.plain).disabled(memory.saving)
						}
					}
				}
			}.frame(width: 190)
			Divider()
			VStack(alignment: .leading, spacing: 12) {
				if memory.loadingDocument { ProgressView(L("读取中…")) }
				else if let error = memory.documentError { errorView(error) { if let path = memory.selectedPath { memory.selectFile(path) } } }
				else if let current = memory.current {
					Text(current.path).font(.headline).textSelection(.enabled)
					Text(L("当前内容")).font(.subheadline.bold())
					contentBox(current.content)
					Text(L("历史版本")).font(.subheadline.bold())
					if let versions = memory.versions, !versions.versions.isEmpty {
						Picker(L("选择版本"), selection: Binding(get: { selectedVersion ?? "" }, set: { version in selectedVersion = version; memory.selectVersion(version) })) {
							Text(L("选择一个版本查看")).tag("")
							ForEach(versions.versions) { version in
								Text(versionLabel(version)).tag(version.version)
							}
						}.disabled(memory.saving)
					} else { Text(L("还没有历史版本")).foregroundStyle(.secondary) }
					if memory.loadingPreview { ProgressView(L("读取中…")) }
					if let error = memory.previewError { errorView(error) { if let selectedVersion { memory.selectVersion(selectedVersion) } } }
					if let preview = memory.preview {
						contentBox(preview.content)
						Button(L("预览恢复…")) { confirmingRestore = true }.disabled(!memory.canRestore)
					}
				} else if !memory.loadingFiles { Text(L("选择一个记忆文件")).foregroundStyle(.secondary) }
			}.frame(maxWidth: .infinity, alignment: .leading)
		}.frame(maxHeight: .infinity, alignment: .top)
	}

	private func versionLabel(_ version: MemoryVersionSummary) -> String {
		let date = version.recordedAt.flatMap(ShellModel.parse).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? L("已有内容")
		return "\(date) · \(version.version.prefix(8))\(version.current ? " · " + L("当前") : "")"
	}

	private func contentBox(_ content: String?) -> some View {
		ScrollView {
			Text(content.map { $0.isEmpty ? L("（空文件）") : $0 } ?? L("当前文件不存在"))
				.font(.system(.callout, design: .monospaced)).textSelection(.enabled)
				.frame(maxWidth: .infinity, alignment: .topLeading).padding(10)
		}.frame(minHeight: 90, idealHeight: 150, maxHeight: 220)
			.background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
	}

	private var restoreConfirmation: some View {
		VStack(alignment: .leading, spacing: 16) {
			Text(L("确认恢复这个版本？")).font(.headline)
			Text(memory.current?.path ?? "").font(.callout).textSelection(.enabled)
			HStack(alignment: .top, spacing: 16) {
				VStack(alignment: .leading) { Text(L("当前内容")).font(.subheadline.bold()); contentBox(memory.current?.content) }
				VStack(alignment: .leading) { Text(L("恢复后的内容")).font(.subheadline.bold()); contentBox(memory.preview?.content) }
			}
			Text(L("确认后替换整份文件，并保存原内容的历史版本。若文件已被其他操作更新，本次恢复会停止，需重新预览。"))
				.font(.callout).foregroundStyle(.secondary)
			if memory.current?.path == "context/constraints.md" {
				Text(L("这里只恢复原有约定文件；下方逐条管理的约定不会被覆盖。"))
					.font(.callout).foregroundStyle(.secondary)
			}
			HStack { Spacer(); Button(L("取消")) { confirmingRestore = false }
				Button(L("确认恢复")) { memory.restorePreview(); confirmingRestore = false }
					.buttonStyle(.borderedProminent).disabled(!memory.canRestore)
			}
		}.padding(24).frame(width: 680)
	}

	private var agreementsBrowser: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				HStack {
					Text(L("由你确认的长期约定")).font(.headline)
					Spacer()
					Button { addingAgreement = true } label: { Label(L("添加约定"), systemImage: "plus") }
						.disabled(memory.agreements == nil || memory.saving || memory.loadingAgreements)
				}
				Text(L("偏好、限制或授权可逐条保存，设定到期时间，或随时撤销。它不能自行扩大你的授权。"))
					.font(.callout).foregroundStyle(.secondary)
				if memory.loadingAgreements { ProgressView(L("读取中…")) }
				if let error = memory.agreementsError { errorView(error) { memory.loadAgreements() } }
				if let agreements = memory.agreements {
					if agreements.items.isEmpty { Text(L("还没有逐条约定")).foregroundStyle(.secondary) }
					ForEach(agreements.items) { item in agreementRow(item) }
					if let legacy = agreements.legacy.content, !legacy.isEmpty {
						Divider()
						DisclosureGroup(L("原有约定文件（保留原文）")) {
							Text(L("原有约定尚未自动拆成条目。它与逐条约定同时保留；要恢复旧文件，请到「文件与版本」。"))
								.font(.caption).foregroundStyle(.secondary)
							Text(legacy).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
						}
					}
				}
			}.frame(maxWidth: .infinity, alignment: .leading)
		}
	}

	private func agreementRow(_ item: MemoryAgreement) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack {
				Text(L(["preference": "偏好", "restriction": "限制", "authorization": "授权"][item.kind] ?? "未知"))
					.font(.caption.bold())
				Text(L(["draft": "草稿", "active": "有效", "revoked": "已撤销", "expired": "已到期"][item.status] ?? "未知"))
					.font(.caption).foregroundStyle(item.status == "active" ? .green : .secondary)
				Spacer()
				if item.status == "draft" {
					Button(L("启用")) { agreementToChange = AgreementConfirmation(agreement: item, action: .activate) }.disabled(memory.saving)
				}
				if item.status == "draft" || item.status == "active" {
					Button(L("撤销")) { agreementToChange = AgreementConfirmation(agreement: item, action: .revoke) }.disabled(memory.saving)
				}
			}
			Text(item.text).font(.callout).textSelection(.enabled)
			if let date = item.expiresAt.flatMap(ShellModel.parse) {
				Text(Lf("到期：%@", date.formatted(date: .abbreviated, time: .shortened))).font(.caption).foregroundStyle(.secondary)
			}
		}.padding(12).frame(maxWidth: .infinity, alignment: .leading)
			.background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
	}

	private func errorView(_ text: String, retry: @escaping () -> Void) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(text).font(.callout).foregroundStyle(.orange).textSelection(.enabled)
			Button(L("重试"), action: retry)
		}
	}
}

private struct NewAgreementView: View {
	@Environment(\.dismiss) private var dismiss
	@State private var text = ""
	@State private var kind = "preference"
	@State private var active = true
	@State private var expires = false
	@State private var expiresAt = Date().addingTimeInterval(86400 * 30)
	let save: (String, String, Bool, Date?) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			Text(L("添加长期约定")).font(.headline)
			Picker(L("类型"), selection: $kind) {
				Text(L("偏好")).tag("preference"); Text(L("限制")).tag("restriction"); Text(L("授权")).tag("authorization")
			}
			TextEditor(text: $text).font(.body).frame(height: 140).border(.secondary.opacity(0.2))
				.accessibilityLabel(L("约定内容"))
			Toggle(L("确认后立即生效（关闭则保存为草稿）"), isOn: $active)
			Toggle(L("设置到期时间"), isOn: $expires)
			if expires { DatePicker(L("到期时间"), selection: $expiresAt, in: Date()...) }
			Text(L("确认前请检查完整内容。约定会进入它的上下文，但不会改变程序提供的工具权限。"))
				.font(.callout).foregroundStyle(.secondary)
			HStack {
				Spacer(); Button(L("取消")) { dismiss() }
				Button(L(active ? "确认并启用" : "保存草稿")) {
					save(text.trimmingCharacters(in: .whitespacesAndNewlines), kind, active, expires ? expiresAt : nil); dismiss()
				}.buttonStyle(.borderedProminent)
					.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (expires && expiresAt <= Date()))
			}
		}.padding(24).frame(width: 520)
	}
}
