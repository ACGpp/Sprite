import Foundation
import XCTest
import SpriteRPC
@testable import sprite_shell

final class RequestRecoveryTests: XCTestCase {
	@MainActor
	private func eventually(_ label: String, _ condition: @MainActor () -> Bool) async throws {
		let deadline = ContinuousClock.now.advanced(by: .seconds(5))
		while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
		XCTAssertTrue(condition(), label)
	}

	@MainActor
	private func withCore(mode: String, _ body: @MainActor (ShellModel, URL) async throws -> Void) async throws {
		let root = FileManager.default.temporaryDirectory.appendingPathComponent("sprite-request-\(UUID().uuidString)")
		try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
		let socket = "/tmp/srq-\(UUID().uuidString.prefix(12)).sock"
		let ready = root.appendingPathComponent("ready")
		let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/request-failure-core.mjs")
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
		process.arguments = ["node", fixture.path, socket, ready.path, mode]
		try process.run()
		let model = ShellModel(socketPath: socket)
		defer {
			model.stop()
			if process.isRunning { process.terminate(); process.waitUntilExit() }
			try? FileManager.default.removeItem(atPath: socket)
			try? FileManager.default.removeItem(at: root)
		}
		try await eventually("Fixture started") { FileManager.default.fileExists(atPath: ready.path) }
		model.start()
		try await eventually("Shell connected") { model.connected }
		try await body(model, URL(fileURLWithPath: ready.path + ".requests"))
	}

	private func requests(_ url: URL) throws -> [[String: Any]] {
		try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
	}

	@MainActor
	func testDocumentTransportFailureReconnectsWithoutSendingChatAndKeepsDraft() async throws {
		try await withCore(mode: "document") { model, _ in
			model.draft = "UNSENT_DRAFT"
			var failure: String?
			let first: String = await withCheckedContinuation { continuation in
				model.loadDocument(path: "diary/test.md", onFailure: { failure = $0 }) { continuation.resume(returning: $0) }
			}
			XCTAssertTrue(first.isEmpty)
			XCTAssertNotNil(failure)
			XCTAssertFalse(model.connected, "A dead request socket must be visible even while subscription lives")
			try await eventually("Query failure reconnects automatically") { model.connected }
			let second: String = await withCheckedContinuation { continuation in
				model.loadDocument(path: "diary/test.md") { continuation.resume(returning: $0) }
			}
			XCTAssertEqual(second, "RECOVERED")
			XCTAssertEqual(model.draft, "UNSENT_DRAFT")
		}
	}

	@MainActor
	func testBusinessRejectionDoesNotDisconnectOrRecreateTheClient() async throws {
		try await withCore(mode: "rejection") { model, log in
			var failure: String?
			let _: String = await withCheckedContinuation { continuation in
				model.loadDocument(path: "diary/test.md", onFailure: { failure = $0 }) { continuation.resume(returning: $0) }
			}
			XCTAssertTrue(failure?.contains("BUSINESS_REJECTION") == true)
			XCTAssertTrue(model.connected)
			let second: String = await withCheckedContinuation { continuation in
				model.loadDocument(path: "diary/test.md") { continuation.resume(returning: $0) }
			}
			XCTAssertEqual(second, "RECOVERED")
			XCTAssertEqual(try requests(log).filter { $0["type"] as? String == "query.snapshot" }.count, 1)
		}
	}

	@MainActor
	func testApprovalTransportFailureReconnectsAndRetryKeepsDecisionID() async throws {
		try await withCore(mode: "approval") { model, log in
			model.answerQuestion("approval", answer: "Yes")
			try await eventually("Approval failure is visible") { model.questionErrors["approval"] != nil }
			XCTAssertFalse(model.connected)
			XCTAssertEqual(model.pendingQuestions.count, 1)
			try await eventually("Approval reconnect") { model.connected }
			model.answerQuestion("approval", answer: "Yes")
			try await eventually("Retry is confirmed") { model.pendingQuestions.isEmpty }
			let commands = try requests(log).compactMap { $0["command"] as? [String: Any] }
			XCTAssertEqual(commands.count, 2)
			XCTAssertEqual(commands[0]["id"] as? String, commands[1]["id"] as? String)
		}
	}

	@MainActor
	func testMemoryMutationSurvivesReconnectRefreshWithOriginalIDAndRevision() async throws {
		try await withCore(mode: "memory") { shell, log in
			let model = MemoryManagementModel(request: shell.manageMemory)
			model.loadAgreements()
			try await eventually("Agreements loaded") { model.agreements != nil }
			model.addAgreement(text: "Preference", kind: "preference", active: true, expiresAt: nil)
			try await eventually("Mutation error visible") { model.mutationError != nil }
			try await eventually("Mutation transport recovered") { shell.connected }
			model.refreshAfterReconnect() // Same path as the memory view's connection observer.
			try await eventually("Fresh read completed") { !model.loadingAgreements }
			XCTAssertNotNil(model.mutationError, "Reconnect must not erase an unknown write outcome")
			model.retryMutation()
			try await eventually("Original decision confirmed") { model.notice != nil }
			let mutations = try requests(log).filter { $0["action"] as? String == "agreement.add" }
			XCTAssertEqual(mutations.count, 2)
			XCTAssertEqual(mutations[0]["commandId"] as? String, mutations[1]["commandId"] as? String)
			XCTAssertEqual(mutations[0]["baseRevision"] as? String, mutations[1]["baseRevision"] as? String)
		}
	}

	@MainActor
	func testStatusRefreshTransportFailureReconnects() async throws {
		try await withCore(mode: "status") { model, _ in
			var disconnected = false
			model.onConnectionChange = { connected, _ in if !connected { disconnected = true } }
			model.refreshNow()
			try await eventually("Status failure triggers reconnection") { disconnected && model.connected }
			XCTAssertNil(model.conversationInputStatus)
		}
	}
}
