import Foundation

/// 一条对话（我说的 / 它说的）。契约镜像的一部分，**纯值类型**。
///
/// 放在库里而不是外壳里：这样测试 target 能直接覆盖合并规则
/// （排序、乐观回显、安静时段收着的话、旧历史过滤），不用起界面。
public struct ConversationTurn: Sendable, Equatable, Identifiable {
	public let id: String
	public let fromMe: Bool
	public let text: String
	public let at: String
	public let seq: Int
	/// 从旧记忆导入的历史（几个月前的聊天）
	public let imported: Bool
	/// 已发出、内核还没回显（本地乐观显示）
	public let pending: Bool
	/// 安静时段被内核收着的话（channel=digest）：界面上要标出来
	public let heldBack: Bool
	public let failure: String?

	public init(
		id: String,
		fromMe: Bool,
		text: String,
		at: String,
		seq: Int,
		imported: Bool = false,
		pending: Bool = false,
		heldBack: Bool = false,
		failure: String? = nil
	) {
		self.id = id
		self.fromMe = fromMe
		self.text = text
		self.at = at
		self.seq = seq
		self.imported = imported
		self.pending = pending
		self.heldBack = heldBack
		self.failure = failure
	}
}

public enum Conversation {
	/// 合并规则：按 journal 的 **seq** 排（seq 是唯一的因果顺序）；
	/// 已发送但内核还没回显的几句放在最末尾并标成 pending（点了发送立刻能看到）。
	public static func merge(
		messages: [IncomingMessage],
		outgoing: [OutgoingMessage],
		optimistic: [String] = []
	) -> [ConversationTurn] {
		var turns: [ConversationTurn] = []
		for message in messages {
			turns.append(ConversationTurn(
				id: message.id ?? "in-\(message.seq)",
				fromMe: true,
				text: message.text,
				at: message.at,
				seq: message.seq,
				imported: message.imported ?? false
			))
		}
		for message in outgoing {
			turns.append(ConversationTurn(
				id: "out-\(message.seq)",
				fromMe: false,
				text: message.text,
				at: message.at,
				seq: message.seq,
				imported: message.imported ?? false,
				// 安静时段收着的：不是导入的、channel 是 digest
				heldBack: message.channel == "digest" && (message.imported ?? false) == false
			))
		}
		turns.sort { $0.seq < $1.seq }
		for (index, text) in optimistic.enumerated() {
			turns.append(ConversationTurn(
				id: "local-\(index)",
				fromMe: true,
				text: text,
				at: "",
				seq: Int.max,
				pending: true
			))
		}
		return turns
	}

	/// 与内核的记录分组、session 使用同一个上海自然日。
	public static func dayStart(_ date: Date) -> Date {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
		return calendar.startOfDay(for: date)
	}

	/// 「现在」只展示今天的新对话；历史仍保留在「对话记录」。
	public static func live(_ turns: [ConversationTurn], now: Date = Date()) -> [ConversationTurn] {
		let start = dayStart(now)
		let parser = ISO8601DateFormatter()
		let fractionalParser = ISO8601DateFormatter()
		fractionalParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return turns.filter { turn in
			guard !turn.imported else { return false }
			if turn.pending || turn.failure != nil { return true }
			guard let at = fractionalParser.date(from: turn.at) ?? parser.date(from: turn.at) else { return false }
			return dayStart(at) == start
		}
	}
}
