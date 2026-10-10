import Foundation
import XCTest
import SpriteRPC
@testable import sprite_shell

@MainActor
private final class MemoryTransport {
	struct Call {
		let parameters: [String: JSONValue]
		let reply: MemoryManagementModel.Reply
	}
	var calls: [Call] = []
	func request(_ parameters: [String: JSONValue], reply: @escaping MemoryManagementModel.Reply) { calls.append(Call(parameters: parameters, reply: reply)) }
	func respond(_ index: Int, _ json: String) throws {
		calls[index].reply(.success(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))))
	}
	func fail(_ index: Int) { calls[index].reply(.failure(MemoryManagementFailure(message: "network unavailable"))) }
}

final class MemoryManagementTests: XCTestCase {
	@MainActor
	func testConfirmationKeepsActionAndCommandTogetherForSameAgreement() throws {
		let transport = MemoryTransport()
		let model = MemoryManagementModel(request: transport.request)
		model.loadAgreements()
		try transport.respond(0, #"{"revision":"r1","items":[{"id":"a1","text":"A confirmed preference","kind":"preference","status":"draft","createdAt":"2026-09-21T00:00:00Z"}],"legacy":{"path":"context/constraints.md","content":null,"version":"missing"}}"#)
		let item = try XCTUnwrap(model.agreements?.items.first)
		let activate = AgreementConfirmation(agreement: item, action: .activate)
		let revoke = AgreementConfirmation(agreement: item, action: .revoke)
		XCTAssertNotEqual(activate.id, revoke.id, "Different decisions about one item must have different sheet identities")
		XCTAssertEqual(activate.title, "确认启用这条约定？")
		XCTAssertEqual(activate.buttonTitle, "确认启用")
		model.changeAgreement(activate.agreement, activate: activate.activating)
		XCTAssertEqual(transport.calls[1].parameters["action"], .string("agreement.activate"))
		transport.fail(1)
		XCTAssertEqual(revoke.title, "确认撤销这条约定？")
		XCTAssertEqual(revoke.buttonTitle, "确认撤销")
		model.changeAgreement(revoke.agreement, activate: revoke.activating)
		XCTAssertEqual(transport.calls[2].parameters["action"], .string("agreement.revoke"))
	}

	@MainActor
	func testLateFileAndVersionResponsesCannotReplaceCurrentSelection() throws {
		let transport = MemoryTransport()
		let model = MemoryManagementModel(request: transport.request)
		model.selectFile("identity.md")
		model.selectFile("notes/new.md")
		try transport.respond(0, #"{"path":"identity.md","currentVersion":"old","versions":[]}"#)
		XCTAssertEqual(transport.calls.count, 2, "Late file response must not start a stale body read")
		try transport.respond(1, #"{"path":"notes/new.md","currentVersion":"new","versions":[]}"#)
		try transport.respond(2, #"{"path":"notes/new.md","version":"new","content":"selected file"}"#)
		XCTAssertEqual(model.current?.content, "selected file")
		model.selectVersion("v1")
		model.selectVersion("v2")
		try transport.respond(4, #"{"path":"notes/new.md","version":"v2","content":"second version"}"#)
		try transport.respond(3, #"{"path":"notes/new.md","version":"v1","content":"stale version"}"#)
		XCTAssertEqual(model.preview?.content, "second version")
	}

	@MainActor
	func testRestoreRequiresCompletePreviewAndKeepsCASAndIDAcrossFailure() throws {
		let transport = MemoryTransport()
		let model = MemoryManagementModel(request: transport.request)
		model.restorePreview()
		XCTAssertTrue(transport.calls.isEmpty)
		model.selectFile("identity.md")
		try transport.respond(0, #"{"path":"identity.md","currentVersion":"current","versions":[]}"#)
		try transport.respond(1, #"{"path":"identity.md","version":"current","content":"current identity"}"#)
		model.selectVersion("older")
		XCTAssertFalse(model.canRestore)
		try transport.respond(2, #"{"path":"identity.md","version":"older","content":"previous identity"}"#)
		XCTAssertTrue(model.canRestore)
		model.restorePreview()
		model.restorePreview()
		XCTAssertEqual(transport.calls.count, 4, "Double clicking cannot create a second write")
		let first = transport.calls[3].parameters
		XCTAssertEqual(first["baseVersion"], .string("current"))
		XCTAssertEqual(first["version"], .string("older"))
		transport.fail(3)
		XCTAssertNotNil(model.mutationError)
		XCTAssertEqual(model.preview?.content, "previous identity")
		model.retryMutation()
		XCTAssertEqual(transport.calls[4].parameters, first, "Unknown outcome retries the same confirmed content and command ID")
		try transport.respond(4, #"{"verified":true,"path":"identity.md","version":"older"}"#)
		XCTAssertNil(model.mutationError)
		XCTAssertNotNil(model.notice)
	}

	@MainActor
	func testMissingVersionCannotBeRestoredAndMalformedResponseIsVisible() throws {
		let transport = MemoryTransport()
		let model = MemoryManagementModel(request: transport.request)
		model.selectFile("identity.md")
		try transport.respond(0, #"{"path":"identity.md","currentVersion":"current","versions":[]}"#)
		try transport.respond(1, #"{"path":"identity.md","version":"current","content":"current identity"}"#)
		model.selectVersion("missing")
		try transport.respond(2, #"{"path":"identity.md","version":"missing","content":null}"#)
		XCTAssertFalse(model.canRestore, "Version browsing must not become implicit file deletion")
		model.selectFile("identity.md")
		try transport.respond(3, #"{"path":"wrong.md","currentVersion":"x","versions":[]}"#)
		XCTAssertNotNil(model.documentError)
		XCTAssertFalse(model.loadingDocument)
	}

	@MainActor
	func testAgreementsKeepRevisionAndStableIDForRetryAndDistinctDecision() throws {
		let transport = MemoryTransport()
		let model = MemoryManagementModel(request: transport.request)
		model.loadAgreements()
		try transport.respond(0, #"{"revision":"r1","items":[],"legacy":{"path":"context/constraints.md","content":null,"version":"missing"}}"#)
		model.addAgreement(text: "Keep quiet", kind: "restriction", active: true, expiresAt: nil)
		let first = transport.calls[1].parameters
		XCTAssertEqual(first["baseRevision"], .string("r1"))
		XCTAssertEqual(first["status"], .string("active"))
		transport.fail(1)
		model.addAgreement(text: "Keep quiet", kind: "restriction", active: true, expiresAt: nil)
		XCTAssertEqual(transport.calls[2].parameters, first)
		transport.fail(2)
		model.addAgreement(text: "Different", kind: "preference", active: false, expiresAt: nil)
		XCTAssertNotEqual(transport.calls[3].parameters["commandId"], first["commandId"])
		XCTAssertEqual(transport.calls[3].parameters["status"], .string("draft"))
	}

	@MainActor
	func testChangedCompanionNamePreservesStateAndCanBeCleared() throws {
		let state = try JSONDecoder().decode(KernelState.self, from: Data(#"{"presence":"paused","companionName":"Old","thoughts":["retained"]}"#.utf8))
		XCTAssertEqual(state.withCompanionName("New").companionName, "New")
		XCTAssertEqual(state.withCompanionName("New").thoughts, ["retained"])
		XCTAssertNil(state.withCompanionName(nil).companionName)
		XCTAssertEqual(SpriteEvent.KnownEventType(rawValue: "identity.changed"), .identityChanged)
	}

	@MainActor
	func testDisconnectedManagementReturnsAnErrorWithoutClaimingSuccess() {
		let shell = ShellModel(socketPath: "/tmp/sprite-missing-memory.sock")
		var received = false
		shell.manageMemory(["action": .string("listFiles")]) { result in
			if case .failure = result { received = true }
		}
		XCTAssertTrue(received)
	}
}
