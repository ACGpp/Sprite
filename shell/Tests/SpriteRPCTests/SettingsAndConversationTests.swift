import XCTest
@testable import SpriteRPC

/// 设置解码与对话流合并的单测。
///
/// 这两段逻辑以前住在外壳（executable target）里，只能靠 `--selftest` 在真机上跑；
/// 现在它们在契约镜像库里，测试 target 能直接覆盖——出问题时不用起界面就能定位。
final class SettingsAndConversationTests: XCTestCase {
	// MARK: - 设置解码

	func testDecodesFullSettingsPayload() throws {
		let payload = """
		{
		  "model": {"mode": "custom", "provider": null, "apiFormat": "openai-completions",
		            "baseUrl": "https://api.example.com/v1", "model": "gpt-4o-mini",
		            "modelName": "示例", "hasApiKey": true},
		  "providers": [{"id": "deepseek", "label": "DeepSeek", "hint": "国内可直连"}],
		  "apiFormats": [{"id": "openai-completions", "label": "OpenAI 兼容"}],
		  "quietHours": {"start": 22, "end": 8},
		  "proactive": {"enabled": false, "perDay": 5},
		  "security": {"agentShell": "readonly"},
		  "source": "settings.json",
		  "piAvailable": true,
		  "settingsPath": "/tmp/settings.json",
		  "homeDir": "/tmp/home"
		}
		"""
		let value = try JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8))
		let settings = KernelSettings.decode(value)
		XCTAssertEqual(settings.mode, "custom")
		XCTAssertEqual(settings.apiFormat, "openai-completions")
		XCTAssertEqual(settings.baseUrl, "https://api.example.com/v1")
		XCTAssertEqual(settings.model, "gpt-4o-mini")
		XCTAssertTrue(settings.hasApiKey, "只回「配没配」——值永远不会出现在这里")
		XCTAssertEqual(settings.providers.first?.id, "deepseek")
		XCTAssertEqual(settings.providers.first?.hint, "国内可直连")
		XCTAssertEqual(settings.apiFormats.first?.label, "OpenAI 兼容")
		XCTAssertEqual(settings.quietStart, 22)
		XCTAssertEqual(settings.quietEnd, 8)
		XCTAssertFalse(settings.proactiveEnabled)
		XCTAssertEqual(settings.proactivePerDay, 5)
		XCTAssertEqual(settings.agentShell, "readonly")
		XCTAssertEqual(settings.source, "settings.json")
		XCTAssertTrue(settings.piAvailable)
	}

	func testTolerantDecodeUsesSafeDefaults() {
		// 缺字段 / 空对象 / 完全不是对象：一律给安全默认值，绝不崩
		for value in [JSONValue.object([:]), .null, .string("坏了"), .array([])] {
			let settings = KernelSettings.decode(value)
			XCTAssertEqual(settings.mode, "provider")
			XCTAssertEqual(settings.quietStart, 23)
			XCTAssertEqual(settings.quietEnd, 7)
			XCTAssertEqual(settings.proactivePerDay, 2)
			XCTAssertEqual(settings.agentShell, "on")
			XCTAssertFalse(settings.hasApiKey)
			XCTAssertTrue(settings.providers.isEmpty)
		}
	}

	func testIgnoresUnknownFieldsAndBadEntries() throws {
		// 未来内核加的字段不该影响解码；坏条目直接跳过而不是整份失败
		let payload = """
		{
		  "model": {"mode": "provider", "provider": "deepseek", "model": "deepseek-flash", "futureField": {"x": 1}},
		  "providers": [{"id": "deepseek", "label": "DeepSeek"}, {"label": "没有 id 的坏条目"}],
		  "futureTopLevel": [1, 2, 3]
		}
		"""
		let value = try JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8))
		let settings = KernelSettings.decode(value)
		XCTAssertEqual(settings.model, "deepseek-flash")
		XCTAssertEqual(settings.providers.count, 1, "没有 id 的条目要跳过")
		XCTAssertEqual(settings.providers.first?.hint, "", "缺 hint 就是空字符串")
	}

	// MARK: - 对话流合并

	private func incoming(_ text: String, seq: Int, imported: Bool = false) -> IncomingMessage {
		IncomingMessage(text: text, source: "text", seq: seq, at: "2026-09-12T01:00:0\(seq % 10)Z", imported: imported)
	}

	private func outgoing(_ text: String, seq: Int, channel: String = "bubble", imported: Bool = false) -> OutgoingMessage {
		OutgoingMessage(text: text, channel: channel, seq: seq, at: "2026-09-12T01:00:0\(seq % 10)Z", imported: imported)
	}

	func testMergeOrdersBySeqAcrossBothSides() {
		let turns = Conversation.merge(
			messages: [incoming("我说的第一句", seq: 5), incoming("我说的第二句", seq: 9)],
			outgoing: [outgoing("它回的第一句", seq: 7)]
		)
		XCTAssertEqual(turns.map(\.text), ["我说的第一句", "它回的第一句", "我说的第二句"])
		XCTAssertEqual(turns.map(\.fromMe), [true, false, true])
		XCTAssertEqual(turns.map(\.seq), [5, 7, 9])
	}

	func testOptimisticEchoesGoLastAndAreMarkedPending() {
		let turns = Conversation.merge(
			messages: [incoming("已经确认的一句", seq: 5)],
			outgoing: [],
			optimistic: ["刚发出还没回显", "第二条"]
		)
		XCTAssertEqual(turns.count, 3)
		XCTAssertEqual(turns.last?.text, "第二条")
		XCTAssertTrue(turns.suffix(2).allSatisfy { $0.pending && $0.fromMe })
		XCTAssertFalse(turns.first?.pending ?? true)
	}

	func testHeldBackIsDigestOnlyAndNeverImported() {
		let turns = Conversation.merge(
			messages: [],
			outgoing: [
				outgoing("安静时段收着的", seq: 3, channel: "digest"),
				outgoing("正常弹出来的", seq: 4, channel: "bubble"),
				outgoing("旧历史里的 digest", seq: 5, channel: "digest", imported: true),
			]
		)
		XCTAssertTrue(turns[0].heldBack, "digest 要标成「安静时段收着的」")
		XCTAssertFalse(turns[1].heldBack)
		XCTAssertFalse(turns[2].heldBack, "导入的旧记录不算收着的")
		XCTAssertTrue(turns[2].imported)
	}

	func testLiveViewHidesImportedHistory() {
		let turns = Conversation.merge(
			messages: [incoming("几个月前的话", seq: 1, imported: true), incoming("今天的", seq: 8)],
			outgoing: [outgoing("旧的回复", seq: 2, imported: true), outgoing("刚回复的", seq: 9)]
		)
		XCTAssertEqual(turns.count, 4, "完整对话流里旧历史还在（归档要用）")
		XCTAssertEqual(Conversation.live(turns).map(\.text), ["今天的", "刚回复的"])
	}

	func testKernelStateDecodesTodayActivityAndIdleStreak() throws {
		let json = """
		{"presence":"quiet","runs":12,"today":{"day":"2026-09-14","wakes":12,"actions":5,"writes":1,"reads":3,"said":2},"idleStreak":7}
		"""
		let state = try JSONDecoder().decode(KernelState.self, from: Data(json.utf8))
		XCTAssertEqual(state.today?.wakes, 12)
		XCTAssertEqual(state.today?.writes, 1)
		XCTAssertEqual(state.today?.reads, 3)
		XCTAssertEqual(state.idleStreak, 7)
		XCTAssertEqual(state.today?.summary, "今天：醒来 12 次 · 写了 1 · 读了 3 · 说话 2")
	}

	func testKernelStateToleratesMissingTodayFields() throws {
		// 旧内核没有 today / idleStreak：必须照样解码（契约镜像的容错约定）
		let json = """
		{"presence":"breathing","runs":3}
		"""
		let state = try JSONDecoder().decode(KernelState.self, from: Data(json.utf8))
		XCTAssertNil(state.today)
		XCTAssertEqual(state.idleStreak, 0)
	}

	// MARK: - 说话卡片什么时候弹（两次真实反馈的交汇点）

	func testCardShowsWhenUserIsInAnotherApp() {
		// 真实事故：用户发了消息就去干别的了，它在面板开着的情况下回复，
		// 老实现把"窗口开着"当成"你在看" → 什么都不弹，回复没人看见。
		XCTAssertTrue(SpeakingPolicy.shouldShowCard(panelShown: true, appActive: false, recordsLiveOnScreen: true))
		XCTAssertTrue(SpeakingPolicy.shouldShowCard(panelShown: false, appActive: false, recordsLiveOnScreen: false))
	}

	func testCardSuppressedWhenUserIsLookingAtTheConversation() {
		// 真实反馈：面板就在眼前时不该重复弹（"他在面板上已经回复我了"）
		XCTAssertFalse(SpeakingPolicy.shouldShowCard(panelShown: true, appActive: true, recordsLiveOnScreen: false))
		XCTAssertFalse(SpeakingPolicy.shouldShowCard(panelShown: false, appActive: true, recordsLiveOnScreen: true))
	}

	func testCardShowsWhenRecordsWindowIsNotOnScreen() {
		// 记录窗口开着，但被别的 app 盖住 / 在别的 Space：你看不见它，就该弹
		XCTAssertTrue(SpeakingPolicy.shouldShowCard(panelShown: false, appActive: true, recordsLiveOnScreen: false))
	}
}
