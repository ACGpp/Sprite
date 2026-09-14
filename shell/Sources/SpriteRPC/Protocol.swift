import Foundation

/// 契约镜像（与 contracts/events.ts 一一对应）。
///
/// 这里是**手写镜像**，不是代码生成：内核是唯一权威，Swift 侧只负责解码，
/// 并且必须容忍未知字段与未知事件类型（旧外壳连新内核不能崩）。
public let protocolVersion = 1

public struct SpriteEvent: Decodable, Equatable, Sendable {
	public let seq: Int
	public let at: String
	public let type: String
	public let data: [String: JSONValue]
	public let causeId: String?

	public init(seq: Int, at: String, type: String, data: [String: JSONValue], causeId: String? = nil) {
		self.seq = seq
		self.at = at
		self.type = type
		self.data = data
		self.causeId = causeId
	}

	/// 未知事件类型也必须能解码出来（用于前向兼容与诊断）
	public var isKnown: Bool {
		KnownEventType(rawValue: type) != nil
	}

	public enum KnownEventType: String {
		case presenceChanged = "presence.changed"
		case messageIn = "message.in"
		case messageOut = "message.out"
		case thoughtRecorded = "thought.recorded"
		case runStarted = "run.started"
		case runActivity = "run.activity"
		case runFinished = "run.finished"
		case runFailed = "run.failed"
		case breathScheduled = "breath.scheduled"
		case wakeDeferred = "wake.deferred"
		case toolDecided = "tool.decided"
		case questionAsked = "question.asked"
		case commandApplied = "command.applied"
		case legacyImported = "legacy.imported"
		case systemProblem = "system.problem"
	}
}

public struct RPCResponse: Decodable {
	public let id: String
	public let ok: Bool
	public let result: JSONValue?
	public let error: String?
}

public enum PresenceState: String, Decodable, Sendable {
	case asleep
	case breathing
	case thinking
	case quiet
	case degraded
	case paused

	/// 未知状态不得让界面空白：退回 asleep 并保留原文用于诊断
	public init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = PresenceState(rawValue: raw) ?? .asleep
	}
}

public struct IncomingMessage: Decodable, Equatable, Sendable {
	public let text: String
	public let source: String
	public let seq: Int
	public let at: String
	public let imported: Bool?

	public init(text: String, source: String, seq: Int, at: String, imported: Bool? = nil) {
		self.text = text
		self.source = source
		self.seq = seq
		self.at = at
		self.imported = imported
	}
}

public struct OutgoingMessage: Decodable, Equatable, Sendable {
	public let text: String
	public let channel: String
	public let seq: Int
	public let at: String
	public let imported: Bool?

	public init(text: String, channel: String, seq: Int, at: String, imported: Bool? = nil) {
		self.text = text
		self.channel = channel
		self.seq = seq
		self.at = at
		self.imported = imported
	}
}

public struct RunActivity: Decodable, Equatable, Sendable {
	public let kind: String
	public let tool: String?
	public let summary: String?
	public let seq: Int
	public let at: String

	public init(kind: String, tool: String?, summary: String?, seq: Int, at: String) {
		self.kind = kind
		self.tool = tool
		self.summary = summary
		self.seq = seq
		self.at = at
	}
}

public struct PendingQuestion: Decodable, Equatable, Sendable {
	public let question: String
	public let options: [String]
	public let seq: Int
	public let at: String

	public init(question: String, options: [String], seq: Int, at: String) {
		self.question = question
		self.options = options
		self.seq = seq
		self.at = at
	}
}

/// 它今天（上海日）做了什么——内核数出来的事实，界面只负责显示。
public struct TodayActivity: Decodable, Equatable, Sendable {
	public let day: String?
	public let wakes: Int
	public let actions: Int
	public let writes: Int
	public let reads: Int
	public let said: Int

	public init(day: String? = nil, wakes: Int = 0, actions: Int = 0, writes: Int = 0, reads: Int = 0, said: Int = 0) {
		self.day = day
		self.wakes = wakes
		self.actions = actions
		self.writes = writes
		self.reads = reads
		self.said = said
	}

	/// 逐字段容错：旧内核没有这些字段时全为 0，而不是解码失败
	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		self.day = try? container.decodeIfPresent(String.self, forKey: .day)
		self.wakes = (try? container.decode(Int.self, forKey: .wakes)) ?? 0
		self.actions = (try? container.decode(Int.self, forKey: .actions)) ?? 0
		self.writes = (try? container.decode(Int.self, forKey: .writes)) ?? 0
		self.reads = (try? container.decode(Int.self, forKey: .reads)) ?? 0
		self.said = (try? container.decode(Int.self, forKey: .said)) ?? 0
	}

	private enum CodingKeys: String, CodingKey {
		case day, wakes, actions, writes, reads, said
	}

	/// 给用户看的一句话（面板与记录窗口用同一份，别各写各的）
	public var summary: String {
		"今天：醒来 \(wakes) 次 · 写了 \(writes) · 读了 \(reads) · 说话 \(said)"
	}
}

public struct KernelState: Decodable, Equatable, Sendable {
	public let presence: PresenceState
	public let nextBreathAt: String?
	public let messages: [IncomingMessage]
	public let pendingMessages: [IncomingMessage]
	public let outgoing: [OutgoingMessage]
	public let thoughts: [String]
	public let activities: [RunActivity]
	public let questions: [PendingQuestion]
	public let toolDecisions: Int
	public let deferrals: Int
	public let runs: Int
	public let danglingRun: Bool
	public let failures: [String]
	public let problems: [String]
	/// 它的名字（由内核给出——外壳不编名字）
	public let companionName: String?
	/// 它今天做了什么（内核给的读数；旧内核没有就是 nil）
	public let today: TodayActivity?
	/// 连续多少次醒来一个动作都没做（界面据此提示"它连续空转"）
	public let idleStreak: Int

	public init(
		presence: PresenceState,
		nextBreathAt: String?,
		messages: [IncomingMessage],
		pendingMessages: [IncomingMessage],
		outgoing: [OutgoingMessage],
		thoughts: [String],
		activities: [RunActivity],
		questions: [PendingQuestion],
		toolDecisions: Int,
		deferrals: Int,
		runs: Int,
		danglingRun: Bool,
		failures: [String],
		problems: [String],
		companionName: String? = nil,
		today: TodayActivity? = nil,
		idleStreak: Int = 0
	) {
		self.presence = presence
		self.nextBreathAt = nextBreathAt
		self.messages = messages
		self.pendingMessages = pendingMessages
		self.outgoing = outgoing
		self.thoughts = thoughts
		self.activities = activities
		self.questions = questions
		self.toolDecisions = toolDecisions
		self.deferrals = deferrals
		self.runs = runs
		self.danglingRun = danglingRun
		self.failures = failures
		self.problems = problems
		self.companionName = companionName
		self.today = today
		self.idleStreak = idleStreak
	}

	/// 逐字段容错解码：新外壳必须能连上**旧内核**（字段缺失就用安全默认值），
	/// 也必须能连上**新内核**（多余字段直接忽略）。
	/// 这是"契约镜像"的正确行为——它不是 schema 校验器，而是尽量把已知的东西读出来。
	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		self.presence = (try? container.decode(PresenceState.self, forKey: .presence)) ?? .asleep
		self.nextBreathAt = try? container.decodeIfPresent(String.self, forKey: .nextBreathAt)
		self.messages = (try? container.decode([IncomingMessage].self, forKey: .messages)) ?? []
		self.pendingMessages = (try? container.decode([IncomingMessage].self, forKey: .pendingMessages)) ?? []
		self.outgoing = (try? container.decode([OutgoingMessage].self, forKey: .outgoing)) ?? []
		self.thoughts = (try? container.decode([String].self, forKey: .thoughts)) ?? []
		self.activities = (try? container.decode([RunActivity].self, forKey: .activities)) ?? []
		self.questions = (try? container.decode([PendingQuestion].self, forKey: .questions)) ?? []
		self.toolDecisions = (try? container.decode(Int.self, forKey: .toolDecisions)) ?? 0
		self.deferrals = (try? container.decode(Int.self, forKey: .deferrals)) ?? 0
		self.runs = (try? container.decode(Int.self, forKey: .runs)) ?? 0
		self.danglingRun = (try? container.decode(Bool.self, forKey: .danglingRun)) ?? false
		self.failures = (try? container.decode([String].self, forKey: .failures)) ?? []
		self.problems = (try? container.decode([String].self, forKey: .problems)) ?? []
		self.companionName = try? container.decodeIfPresent(String.self, forKey: .companionName)
		self.today = try? container.decodeIfPresent(TodayActivity.self, forKey: .today)
		self.idleStreak = (try? container.decode(Int.self, forKey: .idleStreak)) ?? 0
	}

	private enum CodingKeys: String, CodingKey {
		case presence, nextBreathAt, messages, pendingMessages, outgoing, thoughts, activities
		case questions, toolDecisions, deferrals, runs, danglingRun, failures, problems
		case companionName, today, idleStreak
	}

	public var lastThought: String? { thoughts.last }
	public var lastOutgoing: OutgoingMessage? { outgoing.last }
	public var pendingCount: Int { pendingMessages.count }
	public var lastQuestion: PendingQuestion? { questions.last }
}

public struct QuietHours: Decodable, Equatable, Sendable {
	public let start: Int
	public let end: Int

	public init(start: Int, end: Int) {
		self.start = start
		self.end = end
	}

	public var description: String {
		String(format: "%02d:00 – %02d:00", start, end)
	}
}

/// 首次运行需要知道的事，由内核如实提供（外壳不读文件、不猜）。
public struct SetupReport: Decodable, Equatable, Sendable {
	public let homeDir: String
	public let hasIdentity: Bool
	public let hasModelConfig: Bool
	public let configPath: String
	/// 旧配置文件（老用户可能还在用）
	public let legacyConfigPath: String?
	/// 设置从哪儿读来的：settings.json / llm.conf / default
	public let settingsSource: String?
	public let piAvailable: Bool
	public let piBin: String
	public let quietHours: QuietHours
	/// 演示/测试环境（记忆之家里有 DEMO 标记）
	public let isDemo: Bool?

	public init(
		homeDir: String,
		hasIdentity: Bool,
		hasModelConfig: Bool,
		configPath: String,
		legacyConfigPath: String? = nil,
		settingsSource: String? = nil,
		piAvailable: Bool,
		piBin: String,
		quietHours: QuietHours,
		isDemo: Bool? = nil
	) {
		self.homeDir = homeDir
		self.hasIdentity = hasIdentity
		self.hasModelConfig = hasModelConfig
		self.configPath = configPath
		self.legacyConfigPath = legacyConfigPath
		self.settingsSource = settingsSource
		self.piAvailable = piAvailable
		self.piBin = piBin
		self.quietHours = quietHours
		self.isDemo = isDemo
	}

	public var demoMode: Bool { isDemo == true }

	public static let piInstallCommand = "npm install -g @mariozechner/pi-coding-agent"

	/// 三步。`hasSpoken` 来自读模型里的留言数——"说第一句话"完成的判据是**真的说过话**。
	public func steps(hasSpoken: Bool) -> [SetupStep] {
		[
			SetupStep(
				title: "准备一个思考引擎",
				detail: piAvailable ? "已找到 pi，它可以自主呼吸。" : "没找到 pi。在终端运行：\(Self.piInstallCommand)",
				done: piAvailable
			),
			SetupStep(
				title: "选一个模型",
				detail: hasModelConfig
					? "模型已经配好了。"
					: "在下面的表里选供应商（或填自己的 OpenAI 格式地址）、粘贴 API Key，按「保存并应用」就行——不用新建任何文件。",
				done: hasModelConfig
			),
			SetupStep(
				title: "说第一句话",
				detail: hasSpoken ? "它已经记得你说过的话了。" : "它还没有和你说过话。说一句，它会慢慢认识自己。",
				done: hasSpoken
			),
		]
	}
}

public struct SetupStep: Equatable, Sendable {
	public let title: String
	public let detail: String
	public let done: Bool

	public init(title: String, detail: String, done: Bool) {
		self.title = title
		self.detail = detail
		self.done = done
	}
}

public struct KernelSnapshot: Decodable, Sendable {
	public let protocolVersion: Int
	public let seq: Int
	public let state: KernelState
	public let piAvailable: Bool
	/// 旧内核没有这一段：缺失时外壳照常工作，只是不显示引导细节
	public let setup: SetupReport?
}
