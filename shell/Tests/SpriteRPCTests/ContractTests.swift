import XCTest
@testable import SpriteRPC

/// 契约测试：Swift 侧必须能解开 Node 内核真实产出的形状，并且**容忍未来的字段**。
/// 旧外壳连上新内核不能崩——这是跨语言契约的底线。
final class ContractTests: XCTestCase {
	/// 取自真实内核 query.snapshot 的形状（字段名与 core/state.ts 一一对应）
	let snapshotJSON = """
	{
	  "protocolVersion": 1,
	  "seq": 18,
	  "piAvailable": true,
	  "state": {
	    "presence": "breathing",
	    "nextBreathAt": "2026-09-10T19:16:44.155Z",
	    "messages": [
	      {"text": "老的回话", "source": "text", "seq": 2, "at": "2026-09-10T18:16:44.100Z", "imported": true},
	      {"text": "今天想读点什么吗？", "source": "text", "seq": 5, "at": "2026-09-10T18:16:44.140Z", "imported": false}
	    ],
	    "pendingMessages": [],
	    "outgoing": [
	      {"text": "我在，今天想读点东西。", "channel": "bubble", "seq": 14, "at": "2026-09-10T18:16:44.150Z", "imported": false}
	    ],
	    "thoughts": ["看完了 9 号的日记。", "今天先待着。"],
	    "activities": [
	      {"kind": "tool", "tool": "say", "summary": "{\\"text\\":\\"我在\\"}", "seq": 12, "at": "2026-09-10T18:16:44.148Z"}
	    ],
	    "toolDecisions": 2,
	    "deferrals": 0,
	    "runs": 1,
	    "danglingRun": false,
	    "failures": [],
	    "problems": [],
	    "importedLines": 0,
	    "lastRunStartSeq": 8
	  }
	}
	"""

	func testSnapshotDecodes() throws {
		let snapshot = try JSONDecoder().decode(KernelSnapshot.self, from: Data(snapshotJSON.utf8))
		XCTAssertEqual(snapshot.protocolVersion, protocolVersion)
		XCTAssertEqual(snapshot.seq, 18)
		XCTAssertTrue(snapshot.piAvailable)
		XCTAssertEqual(snapshot.state.presence, .breathing)
		XCTAssertEqual(snapshot.state.messages.count, 2)
		XCTAssertEqual(snapshot.state.messages.first?.imported, true)
		XCTAssertEqual(snapshot.state.lastThought, "今天先待着。")
		XCTAssertEqual(snapshot.state.lastOutgoing?.channel, "bubble")
		XCTAssertEqual(snapshot.state.activities.first?.tool, "say")
		XCTAssertEqual(snapshot.state.toolDecisions, 2)
		XCTAssertEqual(snapshot.state.pendingCount, 0)
	}

	/// 上面这份夹具刻意**缺少** `questions` 字段——它代表旧内核。
	/// 新外壳连旧内核必须照常工作，缺字段退回安全默认值而不是整块失败。
	func testOlderCoreWithoutNewFieldsStillDecodes() throws {
		XCTAssertFalse(snapshotJSON.contains("questions"), "夹具必须保持「旧内核」的形状")
		let snapshot = try JSONDecoder().decode(KernelSnapshot.self, from: Data(snapshotJSON.utf8))
		XCTAssertTrue(snapshot.state.questions.isEmpty)
		XCTAssertNil(snapshot.state.lastQuestion)
	}

	func testMinimalStateWithNoOptionalFields() throws {
		// 极端情况：内核只给了一个 presence，其余字段全缺
		let minimal = """
		{"presence":"paused"}
		"""
		let state = try JSONDecoder().decode(KernelState.self, from: Data(minimal.utf8))
		XCTAssertEqual(state.presence, .paused)
		XCTAssertTrue(state.messages.isEmpty)
		XCTAssertEqual(state.runs, 0)
		XCTAssertFalse(state.danglingRun)
	}

	func testQuestionsDecodeWhenPresent() throws {
		let json = """
		{"presence":"breathing","questions":[{"question":"今天想让我读点什么？","options":["潮汐那篇","先不用"],"seq":9,"at":"t"}]}
		"""
		let state = try JSONDecoder().decode(KernelState.self, from: Data(json.utf8))
		XCTAssertEqual(state.lastQuestion?.question, "今天想让我读点什么？")
		XCTAssertEqual(state.lastQuestion?.options.count, 2)
	}

	func testUnknownFieldsAreTolerated() throws {
		// 模拟内核将来新增字段：外壳必须照常解码
		let future = snapshotJSON.replacingOccurrences(
			of: "\"seq\": 18,",
			with: "\"seq\": 18, \"newFancyField\": {\"nested\": [1, 2, 3]},"
		)
		let snapshot = try JSONDecoder().decode(KernelSnapshot.self, from: Data(future.utf8))
		XCTAssertEqual(snapshot.seq, 18)
	}

	func testUnknownEventTypeStillDecodes() throws {
		let json = """
		{"seq": 42, "at": "2026-09-10T18:16:44.155Z", "type": "some.future.event", "data": {"anything": true}}
		"""
		let event = try JSONDecoder().decode(SpriteEvent.self, from: Data(json.utf8))
		XCTAssertEqual(event.seq, 42)
		XCTAssertFalse(event.isKnown, "未知类型不应被当成已知事件")
		XCTAssertEqual(event.data["anything"], .bool(true))
	}

	func testUnknownPresenceFallsBackInsteadOfFailing() throws {
		let json = """
		{"seq": 1, "at": "t", "type": "presence.changed", "data": {"state": "levitating"}}
		"""
		let event = try JSONDecoder().decode(SpriteEvent.self, from: Data(json.utf8))
		XCTAssertEqual(event.data["state"]?.stringValue, "levitating")
		// 读模型里出现未知状态时，界面退回 asleep 而不是整块空白
		let state = """
		{"presence":"levitating","nextBreathAt":null,"messages":[],"pendingMessages":[],"outgoing":[],
		 "thoughts":[],"activities":[],"toolDecisions":0,"deferrals":0,"runs":0,"danglingRun":false,
		 "failures":[],"problems":[]}
		"""
		let decoded = try JSONDecoder().decode(KernelState.self, from: Data(state.utf8))
		XCTAssertEqual(decoded.presence, .asleep)
	}

	func testJSONValueRoundTrip() throws {
		let values: [JSONValue] = [.string("零号"), .number(3.5), .bool(true), .null, .array([.number(1)]), .object(["a": .null])]
		let data = try JSONEncoder().encode(values)
		let decoded = try JSONDecoder().decode([JSONValue].self, from: data)
		XCTAssertEqual(decoded, values)
	}

	func testResponseShape() throws {
		let ok = """
		{"id":"abc","ok":true,"result":{"duplicate":false}}
		"""
		let response = try JSONDecoder().decode(RPCResponse.self, from: Data(ok.utf8))
		XCTAssertTrue(response.ok)
		XCTAssertEqual(response.result?.objectValue?["duplicate"], .bool(false))

		let failed = """
		{"id":"abc","ok":false,"error":"留言内容为空"}
		"""
		let errorResponse = try JSONDecoder().decode(RPCResponse.self, from: Data(failed.utf8))
		XCTAssertFalse(errorResponse.ok)
		XCTAssertEqual(errorResponse.error, "留言内容为空")
	}
}
