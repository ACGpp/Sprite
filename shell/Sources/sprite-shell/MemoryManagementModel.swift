import Foundation
import SpriteRPC

struct MemoryManagementFailure: Error, Sendable {
	let message: String
}

/// Sheet identity includes both the agreement and the user's requested action.
/// Keeping these together prevents a new sheet from capturing a previous action.
struct AgreementConfirmation: Identifiable {
	enum Action: String { case activate, revoke }
	let agreement: MemoryAgreement
	let action: Action
	var id: String { "\(agreement.id):\(action.rawValue)" }
	var activating: Bool { action == .activate }
	var title: String { activating ? "确认启用这条约定？" : "确认撤销这条约定？" }
	var buttonTitle: String { activating ? "确认启用" : "确认撤销" }
	var explanation: String { activating ? "确认后它会作为有效约定进入上下文。约定文字不会扩大实际工具权限。" : "撤销后不再作为有效约定使用，历史记录会保留。" }
}

/// 保存一次预览对应的版本；确认和失败重试始终针对同一份内容。
@MainActor
final class MemoryManagementModel: ObservableObject {
	typealias Reply = @MainActor @Sendable (Result<JSONValue, MemoryManagementFailure>) -> Void
	typealias Request = @MainActor ([String: JSONValue], @escaping Reply) -> Void
	private let request: Request
	@Published private(set) var files: [MemoryFileSummary] = []
	@Published private(set) var selectedPath: String?
	@Published private(set) var versions: MemoryVersionList?
	@Published private(set) var current: MemoryPreview?
	@Published private(set) var preview: MemoryPreview?
	@Published private(set) var agreements: MemoryAgreements?
	@Published private(set) var loadingFiles = false
	@Published private(set) var loadingDocument = false
	@Published private(set) var loadingPreview = false
	@Published private(set) var loadingAgreements = false
	@Published private(set) var saving = false
	@Published private(set) var filesError: String?
	@Published private(set) var documentError: String?
	@Published private(set) var previewError: String?
	@Published private(set) var agreementsError: String?
	@Published private(set) var mutationError: String?
	@Published private(set) var notice: String?
	private var fileLoad = UUID()
	private var documentLoad = UUID()
	private var previewLoad = UUID()
	private var agreementLoad = UUID()
	private var pendingMutation: [String: JSONValue]?

	init(request: @escaping Request) { self.request = request }

	private func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
		try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
	}
	private func failure(_ error: Error) -> String {
		(error as? MemoryManagementFailure)?.message ?? L("内核返回的记忆数据无法读取，请刷新重试")
	}

	func loadFiles() {
		let token = UUID(); fileLoad = token
		loadingFiles = true; filesError = nil
		request(["action": .string("listFiles")]) { [weak self] result in
			guard let self, self.fileLoad == token else { return }
			self.loadingFiles = false
			do {
				self.files = try self.decode(MemoryFileList.self, result.get()).files
				let path = self.selectedPath.flatMap { path in self.files.contains(where: { $0.path == path }) ? path : nil } ?? self.files.first?.path
				if let path { self.selectFile(path) }
				else { self.clearDocument() }
			} catch { self.filesError = self.failure(error) }
		}
	}

	private func clearDocument() {
		documentLoad = UUID(); previewLoad = UUID()
		selectedPath = nil; versions = nil; current = nil; preview = nil
		loadingDocument = false; loadingPreview = false
	}

	func selectFile(_ path: String) {
		guard !saving else { return }
		clearDocument(); selectedPath = path
		let token = UUID(); documentLoad = token
		loadingDocument = true; documentError = nil; previewError = nil
		request(["action": .string("versions"), "path": .string(path)]) { [weak self] result in
			guard let self, self.documentLoad == token else { return }
			do {
				let versions = try self.decode(MemoryVersionList.self, result.get())
				guard versions.path == path else { throw MemoryManagementFailure(message: L("返回的记忆文件不匹配，请刷新重试")) }
				self.versions = versions
				self.request(["action": .string("preview"), "path": .string(path), "version": .string(versions.currentVersion)]) { [weak self] result in
					guard let self, self.documentLoad == token else { return }
					self.loadingDocument = false
					do {
						let content = try self.decode(MemoryPreview.self, result.get())
						guard content.path == path, content.version == versions.currentVersion else { throw MemoryManagementFailure(message: L("返回的记忆版本不匹配，请刷新重试")) }
						self.current = content
					} catch { self.documentError = self.failure(error) }
				}
			} catch { self.loadingDocument = false; self.documentError = self.failure(error) }
		}
	}

	func selectVersion(_ version: String) {
		guard let path = selectedPath, !saving else { return }
		let token = UUID(); previewLoad = token
		preview = nil; previewError = nil; loadingPreview = true
		guard !version.isEmpty else { loadingPreview = false; return }
		request(["action": .string("preview"), "path": .string(path), "version": .string(version)]) { [weak self] result in
			guard let self, self.previewLoad == token, self.selectedPath == path else { return }
			self.loadingPreview = false
			do {
				let content = try self.decode(MemoryPreview.self, result.get())
				guard content.path == path, content.version == version else { throw MemoryManagementFailure(message: L("返回的记忆版本不匹配，请刷新重试")) }
				self.preview = content
			} catch { self.previewError = self.failure(error) }
		}
	}

	var canRestore: Bool {
		guard let current, let preview else { return false }
		return !saving && !loadingDocument && !loadingPreview && current.path == preview.path && current.version != preview.version && preview.content != nil
	}

	func restorePreview() {
		guard canRestore, let current, let preview else { return }
		mutate(["action": .string("restore"), "path": .string(current.path), "version": .string(preview.version), "baseVersion": .string(current.version)])
	}

	func loadAgreements() {
		let token = UUID(); agreementLoad = token
		loadingAgreements = true; agreementsError = nil
		request(["action": .string("agreements")]) { [weak self] result in
			guard let self, self.agreementLoad == token else { return }
			self.loadingAgreements = false
			do { self.agreements = try self.decode(MemoryAgreements.self, result.get()) }
			catch { self.agreementsError = self.failure(error) }
		}
	}

	func addAgreement(text: String, kind: String, active: Bool, expiresAt: Date?) {
		guard let agreements, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
		var payload: [String: JSONValue] = ["action": .string("agreement.add"), "text": .string(text), "agreementKind": .string(kind), "status": .string(active ? "active" : "draft"), "baseRevision": .string(agreements.revision)]
		if let expiresAt { payload["expiresAt"] = .string(ISO8601DateFormatter().string(from: expiresAt)) }
		mutate(payload)
	}

	func changeAgreement(_ item: MemoryAgreement, activate: Bool) {
		guard let agreements else { return }
		mutate(["action": .string(activate ? "agreement.activate" : "agreement.revoke"), "agreementId": .string(item.id), "baseRevision": .string(agreements.revision)])
	}

	func clearMutation() {
		guard !saving else { return }
		pendingMutation = nil; mutationError = nil; notice = nil
	}

	func refresh() {
		guard !saving else { return }
		clearMutation(); loadFiles(); loadAgreements()
	}

	/// 自动重连只刷新读模型；未确认结果的写入必须保留原命令供用户重试。
	func refreshAfterReconnect() {
		guard !saving else { return }
		loadFiles(); loadAgreements()
	}

	private func mutate(_ parameters: [String: JSONValue]) {
		guard !saving else { return }
		var payload = parameters
		// 相同决定在网络错误后重试，复用幂等 ID；改变决定才创建新 ID。
		var previous = pendingMutation
		previous?.removeValue(forKey: "commandId")
		payload["commandId"] = previous == parameters ? pendingMutation?["commandId"] : .string(UUID().uuidString)
		pendingMutation = payload
		sendPendingMutation()
	}

	func retryMutation() { guard pendingMutation != nil, !saving else { return }; sendPendingMutation() }

	private func sendPendingMutation() {
		guard let payload = pendingMutation else { return }
		// A read started before this decision cannot replace the newer mutation result.
		agreementLoad = UUID(); loadingAgreements = false
		saving = true; mutationError = nil; notice = nil
		request(payload) { [weak self] result in
			guard let self else { return }
			self.saving = false
			do {
				let value = try result.get()
				if payload["action"]?.stringValue == "restore" {
					guard value.objectValue?["verified"]?.boolValue == true else { throw MemoryManagementFailure(message: L("未收到写入核验结果，请重试以确认状态")) }
					self.notice = L("已恢复，原来的内容已保留为历史版本")
					self.loadFiles(); self.loadAgreements()
				} else {
					self.agreements = try self.decode(MemoryAgreements.self, value)
					self.notice = L("长期约定已保存")
				}
				self.pendingMutation = nil
			} catch { self.mutationError = self.failure(error) }
		}
	}
}
