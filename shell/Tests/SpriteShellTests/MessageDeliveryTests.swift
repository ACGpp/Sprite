import Foundation
import XCTest
import SpriteRPC
@testable import sprite_shell

/// 直接测试产品 ShellModel；不拷贝业务实现、不启动应用窗口。
final class MessageDeliveryTests: XCTestCase {
	@MainActor
	func testMemoryManagementUsesRealKernelRPCForReadRestoreAndAgreements() async throws {
		try await withSlowCore(mode: "memory-management") { shell, _ in
			let memory = MemoryManagementModel(request: shell.manageMemory)
			memory.refresh()
			try await eventually("Current identity and agreements load through RPC") { memory.current?.content == "CURRENT_IDENTITY" && memory.agreements != nil }
			let previous = try XCTUnwrap(memory.versions?.versions.first(where: { !$0.current }))
			memory.selectVersion(previous.version)
			try await eventually("Old version body loads through RPC") { memory.preview?.content == "OLD_IDENTITY" }
			memory.restorePreview()
			try await eventually("Verified restoration refreshes current content") { memory.current?.content == "OLD_IDENTITY" && memory.notice != nil }
			memory.addAgreement(text: "Remember a preference", kind: "preference", active: false, expiresAt: nil)
			try await eventually("Draft persisted by real store") { memory.agreements?.items.first?.status == "draft" }
			let draft = try XCTUnwrap(memory.agreements?.items.first)
			memory.changeAgreement(draft, activate: true)
			try await eventually("User activation persisted") { memory.agreements?.items.first?.status == "active" }
			let active = try XCTUnwrap(memory.agreements?.items.first)
			memory.changeAgreement(active, activate: false)
			try await eventually("User revocation persisted") { memory.agreements?.items.first?.status == "revoked" }
			XCTAssertNil(memory.mutationError)
		}
	}

	@MainActor
	func testIdentityEventUpdatesDisplayedNameWithoutRestartAndCanClearName() async throws {
		try await withSlowCore(mode: "identity-change") { model, _ in
			XCTAssertEqual(model.companionName, "Old name")
			XCTAssertTrue(model.sendMessage("change"))
			try await eventually("Identity event updates the UI name") { model.companionName == "New name" }
			XCTAssertTrue(model.sendMessage("clear"))
			try await eventually("Clearing identity name restores the unnamed fallback") { model.companionName == nil }
		}
	}

	@MainActor
	func testMemoryAnswerRetryKeepsCommandIDUntilAnswerChanges() async throws {
		try await withSlowCore(mode: "question-reject") { model, commands in
			try await eventually("待确认问题到达") { !model.pendingQuestions.isEmpty }
			model.answerQuestion("test-question", answer: "批准此修改")
			try await eventually("首个失败必须可见") { model.questionErrors["test-question"] != nil }
			model.answerQuestion("test-question", answer: "批准此修改")
			try await eventually("重试失败必须可见") { model.questionErrors["test-question"] != nil }
			model.answerQuestion("test-question", answer: "拒绝此修改")
			try await eventually("更换决定后的失败必须可见") { model.questionErrors["test-question"] != nil }
			let calls = try String(contentsOf: commands, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
			XCTAssertEqual(calls.count, 3)
			XCTAssertEqual(calls[0]["id"] as? String, calls[1]["id"] as? String, "网络结果未知时重试不得成为另一份授权")
			XCTAssertNotEqual(calls[1]["id"] as? String, calls[2]["id"] as? String, "明确改变决定是新命令")
			XCTAssertEqual(model.pendingQuestions.count, 1, "失败不得删除提案卡")
		}
	}

	@MainActor
	private func withSlowCore(mode: String = "reject", _ body: @MainActor (ShellModel, URL) async throws -> Void) async throws {
		let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("sprite-send-\(UUID().uuidString)")
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
		// macOS Unix socket 路径有长度上限，socket 使用短路径。
		let socketPath = "/tmp/spr-\(UUID().uuidString.prefix(12)).sock"
		let ready = root.appendingPathComponent("ready")
		let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/slow-core.mjs")
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
		process.arguments = ["node", fixture.path, socketPath, ready.path, mode]
		let log = root.appendingPathComponent("fixture.log")
		FileManager.default.createFile(atPath: log.path, contents: nil)
		let output = try FileHandle(forWritingTo: log)
		process.standardOutput = output
		process.standardError = output
		try process.run()
		let model = ShellModel(socketPath: socketPath)
		defer {
			model.stop()
			if process.isRunning { process.terminate(); process.waitUntilExit() }
			try? output.close()
			try? FileManager.default.removeItem(atPath: socketPath)
			try? FileManager.default.removeItem(at: root)
		}
		let deadline = Date().addingTimeInterval(5)
		while !FileManager.default.fileExists(atPath: ready.path), process.isRunning, Date() < deadline {
			try await Task.sleep(for: .milliseconds(20))
		}
		XCTAssertTrue(FileManager.default.fileExists(atPath: ready.path), (try? String(contentsOf: log, encoding: .utf8)) ?? "测试服务未启动；需要 Node 24+")
		guard FileManager.default.fileExists(atPath: ready.path) else { return }
		model.start()
		while !model.connected, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
		XCTAssertTrue(model.connected, "夹具连接失败不能算命中发送缺陷")
		guard model.connected else { return }
		try await body(model, URL(fileURLWithPath: ready.path + ".commands"))
	}

	@MainActor
	func testF08SendDoesNotBlockMainActor() async throws {
		try await withSlowCore { model, _ in
			let started = ContinuousClock.now
			_ = model.sendMessage("NONBLOCKING_SENTINEL")
			let elapsed = started.duration(to: .now)
			XCTAssertLessThan(elapsed, .milliseconds(250), "发送操作不能让主线程等待 RPC")
			// 等迟到响应收尾，避免 stop 与进行中的 I/O 竞争。
			try await Task.sleep(for: .seconds(2))
		}
	}

	@MainActor
	func testF08LateRejectionIsVisibleAndTextRecoverable() async throws {
		try await withSlowCore { model, _ in
			let text = "RECOVERABLE_MESSAGE_SENTINEL"
			model.draft = text
			if model.sendMessage(model.draft) { model.draft = "" } // 与 ConversationView 当前调用方式相同
			try await Task.sleep(for: .seconds(2))
			XCTAssertNotNil(model.connectionError, "超过一秒才返回的拒绝也必须显示")
			XCTAssertFalse(model.liveConversation.contains { $0.pending }, "失败不能永久停留在发送中")
			XCTAssertEqual(model.draft, text, "失败文本应可恢复；采用失败卡片后改验卡片文本及重试按钮")
			XCTAssertTrue(model.state?.messages.isEmpty == true, "服务端没有接收这条消息")
		}
	}

	@MainActor
	func testDisconnectedSendKeepsDraft() {
		let model = ShellModel(socketPath: "/tmp/sprite-no-test-server.sock")
		model.draft = "KEEP_DRAFT"
		XCTAssertFalse(model.sendMessage(model.draft))
		XCTAssertEqual(model.draft, "KEEP_DRAFT")
		XCTAssertNotNil(model.connectionError)
		model.stop()
	}
	@MainActor
	private func eventually(_ label: String, _ condition: @MainActor () -> Bool) async throws {
		let deadline = ContinuousClock.now.advanced(by: .seconds(5))
		while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
		XCTAssertTrue(condition(), label)
	}

	@MainActor
	func testLateFailurePreservesNewDraftAndHasRetryCard() async throws {
		try await withSlowCore { model, _ in
			XCTAssertTrue(model.sendMessage("FIRST"))
			model.draft = "NEW_DRAFT"
			try await eventually("失败卡片应出现") { model.liveConversation.contains { $0.failure != nil } }
			XCTAssertEqual(model.draft, "NEW_DRAFT")
			XCTAssertEqual(model.liveConversation.first(where: { $0.failure != nil })?.text, "FIRST")
		}
	}

	@MainActor
	func testRetryReusesStableIDAndConfirmsOnlyOnce() async throws {
		try await withSlowCore(mode: "retry") { model, commands in
			XCTAssertTrue(model.sendMessage("RETRY"))
			try await eventually("等待初次失败") { model.liveConversation.contains { $0.failure != nil } }
			let failed = try XCTUnwrap(model.liveConversation.first(where: { $0.failure != nil }))
			model.retryMessage(id: failed.id)
			model.retryMessage(id: failed.id) // 双击不能增加一次请求
			try await eventually("重试应变为确认消息") { model.state?.messages.count == 1 && model.liveConversation.allSatisfy { !$0.pending && $0.failure == nil } }
			XCTAssertEqual(model.liveConversation.count, 1)
			XCTAssertEqual(model.liveConversation.first?.id, failed.id)
			let calls = try String(contentsOf: commands, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
			XCTAssertEqual(calls.count, 2)
			XCTAssertEqual(calls[0]["id"] as? String, calls[1]["id"] as? String)
		}
	}

	@MainActor
	func testEqualTextsRemainSeparateUntilEachIDIsConfirmed() async throws {
		try await withSlowCore(mode: "duplicate") { model, _ in
			XCTAssertTrue(model.sendMessage("SAME"))
			XCTAssertTrue(model.sendMessage("SAME"))
			let ids = Set(model.liveConversation.map(\.id))
			XCTAssertEqual(ids.count, 2)
			try await eventually("首条确认不能清掉第二条") { model.state?.messages.count == 1 }
			XCTAssertEqual(model.liveConversation.count, 2)
			XCTAssertEqual(model.liveConversation.filter(\.pending).count, 1)
			try await eventually("两条应分别完成") { model.state?.messages.count == 2 && model.liveConversation.allSatisfy { !$0.pending } }
			XCTAssertEqual(Set(model.liveConversation.map(\.id)), ids)
		}
	}

	@MainActor
	func testConversationComposerShowsDisconnectWithExistingTurnsAndPreservesUnsentDraft() async throws {
		try await withSlowCore(mode: "disconnect") { model, _ in
			XCTAssertTrue(model.sendMessage("PERSISTED_BEFORE_DISCONNECT"))
			try await eventually("Subscription disconnect reaches composer") { !model.connected }
			XCTAssertFalse(model.liveConversation.isEmpty, "Regression requires existing conversation content")
			model.draft = "UNSENT_OFFLINE_DRAFT"
			XCTAssertNotNil(model.conversationInputStatus, "Input warning must remain visible despite existing turns")
			XCTAssertFalse(model.canSendDraft)
			XCTAssertFalse(model.sendMessage(model.draft))
			XCTAssertEqual(model.draft, "UNSENT_OFFLINE_DRAFT")
			try await eventually("Automatic reconnect clears the warning") { model.connected && model.conversationInputStatus == nil }
			XCTAssertEqual(model.draft, "UNSENT_OFFLINE_DRAFT", "Reconnect must not silently send or clear a fresh draft")
			XCTAssertTrue(model.canSendDraft)
			XCTAssertFalse(model.state?.messages.contains(where: { $0.text == "UNSENT_OFFLINE_DRAFT" }) == true)
		}
	}

	@MainActor
	func testReconnectReconcilesPersistedMessageByID() async throws {
		try await withSlowCore(mode: "disconnect") { model, _ in
			XCTAssertTrue(model.sendMessage("PERSISTED_BEFORE_DISCONNECT"))
			let id = try XCTUnwrap(model.liveConversation.first?.id)
			try await eventually("重连快照应对账已落库消息") { model.connected && model.state?.messages.count == 1 && model.liveConversation.allSatisfy { !$0.pending && $0.failure == nil } }
			XCTAssertEqual(model.liveConversation.count, 1)
			XCTAssertEqual(model.liveConversation.first?.id, id)
		}
	}

	@MainActor
	func testQuestionAnswerIsBoundToQuestionAndDoubleClickIsIgnored() async throws {
		try await withSlowCore(mode: "question") { model, commands in
			XCTAssertEqual(model.pendingQuestions.first?.questionId, "test-question")
			model.answerQuestion("test-question", answer: "My freeform answer")
			model.answerQuestion("test-question", answer: "My freeform answer")
			try await eventually("已回答的问题应移出待答列表") { model.pendingQuestions.isEmpty }
			let calls = try String(contentsOf: commands, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
			XCTAssertEqual(calls.count, 1)
			XCTAssertEqual(calls.first?["type"] as? String, "question.answer")
			XCTAssertEqual(calls.first?["questionId"] as? String, "test-question")
			XCTAssertEqual(calls.first?["answer"] as? String, "My freeform answer")
		}
	}

	@MainActor
	func testEveryRecordsEntryProducesANavigationRequest() {
		let model = ShellModel(socketPath: "/tmp/sprite-no-test-server.sock")
		var token = model.recordsRequestToken
		for request in [RecordsSectionRequest.settings, .voice, .live, .live, .diary] {
			model.navigateRecords(to: request)
			XCTAssertEqual(model.recordsRequest, request)
			XCTAssertNotEqual(model.recordsRequestToken, token)
			token = model.recordsRequestToken
		}
		model.stop()
	}

	@MainActor
	func testResendingAutomaticallyRecoveredDraftUsesOriginalID() async throws {
		try await withSlowCore(mode: "retry") { model, commands in
			XCTAssertTrue(model.sendMessage("RECOVER_AND_SEND"))
			let id = try XCTUnwrap(model.liveConversation.first?.id)
			try await eventually("失败应恢复到空草稿") { model.draft == "RECOVER_AND_SEND" }
			XCTAssertTrue(model.sendMessage(model.draft))
			model.draft = ""
			try await eventually("草稿重发应沿用原消息") { model.state?.messages.count == 1 && model.liveConversation.allSatisfy { !$0.pending && $0.failure == nil } }
			XCTAssertEqual(model.liveConversation.count, 1)
			XCTAssertEqual(model.liveConversation.first?.id, id)
			let calls = try String(contentsOf: commands, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
			XCTAssertEqual(calls.count, 2)
			XCTAssertEqual(calls[0]["id"] as? String, calls[1]["id"] as? String)
		}
	}

	@MainActor
	func testRejectedAnswerKeepsQuestionAndExplainsFailure() async throws {
		try await withSlowCore(mode: "question-reject") { model, _ in
			model.answerQuestion("test-question", answer: "Yes")
			try await eventually("拒绝必须可见") { model.questionErrors["test-question"] != nil }
			XCTAssertEqual(model.pendingQuestions.count, 1)
			XCTAssertTrue(model.answeringQuestions.isEmpty)
		}
	}

	@MainActor
	func testRecordsCursorLoadsOlderPage() async throws {
		try await withSlowCore(mode: "records") { model, commands in
			var cursor: String?
			let first: [[String: String]] = await withCheckedContinuation { continuation in
				model.loadRecords(kind: "conversations", pageInfo: { cursor = $0 }) { continuation.resume(returning: $0) }
			}
			XCTAssertEqual(first.first?["text"], "NEWER")
			XCTAssertEqual(cursor, "2026-09-19")
			let older: [[String: String]] = await withCheckedContinuation { continuation in
				model.loadRecords(kind: "conversations", beforeDate: cursor, pageInfo: { cursor = $0 }) { continuation.resume(returning: $0) }
			}
			XCTAssertEqual(older.first?["text"], "OLDER")
			XCTAssertNil(cursor)
			let calls = try String(contentsOf: commands, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
			XCTAssertEqual(calls.last?["beforeDate"] as? String, "2026-09-19")
		}
	}

	@MainActor
	func testUnsettledExecutionIsRetainedInShellState() throws {
		let json = #"{"presence":"degraded","unsettledMessages":[{"runId":"uncertain-run","reason":"agent process stopped after a tool","messages":[{"id":"uncertain-message","text":"Write note","source":"text","seq":1,"at":"2026-09-19T00:00:00Z"}]}]}"#
		let state = try JSONDecoder().decode(KernelState.self, from: Data(json.utf8))
		let model = ShellModel(socketPath: "/tmp/sprite-no-test-server.sock")
		model.applyForTest(state)
		XCTAssertEqual(model.state?.unsettledMessages.first?.messages.first?.id, "uncertain-message")
		XCTAssertEqual(model.state?.unsettledMessages.first?.reason, "agent process stopped after a tool")
		model.stop()
	}

	@MainActor
	func testAcceptanceRecordsFailureIsSeparateFromEmptyRecords() async throws {
		try await withSlowCore(mode: "records-error") { model, _ in
			var failure: String?
			let entries: [[String: String]] = await withCheckedContinuation { continuation in
				model.loadRecords(kind: "conversations", attempt: 20, onFailure: { failure = $0 }) {
					continuation.resume(returning: $0)
				}
			}
			XCTAssertTrue(entries.isEmpty)
			XCTAssertTrue(failure?.contains("TEST_RECORDS_UNAVAILABLE") == true, "读取失败必须通过独立错误回调呈现，不能冒充空记录")
		}
	}

	@MainActor
	func testAcceptanceDocumentFailureIsSeparateFromEmptyDocument() async throws {
		try await withSlowCore(mode: "document-error") { model, _ in
			var failure: String?
			let text: String = await withCheckedContinuation { continuation in
				model.loadDocument(path: "diary/test.md", onFailure: { failure = $0 }) {
					continuation.resume(returning: $0)
				}
			}
			XCTAssertTrue(text.isEmpty)
			XCTAssertTrue(failure?.contains("TEST_DOCUMENT_UNAVAILABLE") == true, "正文错误不能被转换成空字符串而丢失原因")
		}
	}

	@MainActor
	func testAcceptanceSuccessfulDocumentHasNoFailure() async throws {
		try await withSlowCore { model, _ in
			var failure: String?
			let text: String = await withCheckedContinuation { continuation in
				model.loadDocument(path: "diary/test.md", onFailure: { failure = $0 }) {
					continuation.resume(returning: $0)
				}
			}
			XCTAssertEqual(text, "DOCUMENT:diary/test.md")
			XCTAssertNil(failure)
		}
	}

}
