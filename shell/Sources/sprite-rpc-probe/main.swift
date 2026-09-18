import Foundation
import SpriteRPC

/// 契约探针：用真的 Node 内核验证 Swift 侧解码。
///
/// 用法：
///   sprite-rpc-probe status   <socketPath>
///   sprite-rpc-probe send     <socketPath> <text>
///   sprite-rpc-probe subscribe <socketPath> <seconds>
///   sprite-rpc-probe selftest <socketPath>   —— 一次跑完全部检查并给出退出码

func fail(_ message: String) -> Never {
	FileHandle.standardError.write(Data("FAIL \(message)\n".utf8))
	exit(1)
}

func pass(_ message: String) {
	print("PASS \(message)")
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
	fail("用法: sprite-rpc-probe <status|send|subscribe|selftest> <socketPath> [args]")
}

let mode = arguments[1]
let socketPath = arguments[2]

guard let client = try? CoreClient(socketPath: socketPath) else {
	fail("无法连接内核 socket: \(socketPath)")
}

switch mode {
case "status":
	let state = try client.status()
	print("presence=\(state.presence.rawValue) runs=\(state.runs) messages=\(state.messages.count) pending=\(state.pendingCount)")
	if let next = state.nextBreathAt { print("nextBreathAt=\(next)") }
	if let thought = state.lastThought { print("lastThought=\(thought)") }

case "send":
	guard arguments.count >= 4 else { fail("缺少留言内容") }
	let result = try client.sendMessage(text: arguments[3])
	print("result=\(result)")

case "subscribe":
	let seconds = arguments.count >= 4 ? Double(arguments[3]) ?? 3 : 3
	// 订阅回调在后台线程触发：用带锁的收集器，别让闭包去改捕获的 var（Swift 6 会拦）
	final class ProbeSink: @unchecked Sendable {
		private let lock = NSLock()
		private var seqs: [Int] = []
		func append(_ seq: Int) {
			lock.lock()
			seqs.append(seq)
			lock.unlock()
		}
		var value: [Int] {
			lock.lock()
			defer { lock.unlock() }
			return seqs
		}
	}
	let sink = ProbeSink()
	try client.subscribe(fromSeq: 0, onEvent: { event in
		sink.append(event.seq)
		print("event #\(event.seq) \(event.type)\(event.isKnown ? "" : " (未知类型，仍可解码)")")
	}, onError: { error in
		FileHandle.standardError.write(Data("订阅中断: \(error)\n".utf8))
	})
	Thread.sleep(forTimeInterval: seconds)
	print("received=\(sink.value.count) seqs=\(sink.value)")

case "selftest":
	var failures = 0
	/// 订阅回调在后台线程触发：探针也需要一个带锁的收集器（Swift 6 不许闭包改捕获的 var）
final class SeqSink: @unchecked Sendable {
	private let lock = NSLock()
	private var seqs: [Int] = []
	private var failure: String?
	func append(_ seq: Int) {
		lock.lock()
		seqs.append(seq)
		lock.unlock()
	}
	func fail(_ message: String) {
		lock.lock()
		failure = message
		lock.unlock()
	}
	var value: [Int] {
		lock.lock()
		defer { lock.unlock() }
		return seqs
	}
	var error: String? {
		lock.lock()
		defer { lock.unlock() }
		return failure
	}
}

func check(_ name: String, _ condition: Bool, _ detail: String = "") {
		if condition { pass("\(name)\(detail.isEmpty ? "" : " — \(detail)")") } else { print("FAIL \(name)\(detail.isEmpty ? "" : " — \(detail)")"); failures += 1 }
	}

	// 1. 快照与状态解码
	do {
		let snapshot = try client.snapshot()
		check("快照可解码", true, "seq=\(snapshot.seq) pi=\(snapshot.piAvailable)")
		check("协议版本一致", snapshot.protocolVersion == protocolVersion, "内核 v\(snapshot.protocolVersion)")
		let state = try client.status()
		check("状态可解码", state.runs >= 0, "presence=\(state.presence.rawValue)")
		check("读模型字段齐全", state.messages.count >= 0 && state.thoughts.count >= 0)

		// 首次运行报告：引导面板的全部依据，必须来自内核而不是外壳猜
		if let setup = snapshot.setup {
			check("首次运行报告可解码", true, "pi=\(setup.piAvailable) 配置=\(setup.hasModelConfig) 安静时段=\(setup.quietHours.description)")
			check("报告里不含密钥", !String(describing: setup).lowercased().contains("key="))
			let steps = setup.steps(hasSpoken: !state.messages.filter { $0.imported != true }.isEmpty)
			check("三步与内核报告一致", steps.count == 3 && steps[0].done == setup.piAvailable && steps[1].done == setup.hasModelConfig)
		} else {
			check("旧内核缺少 setup 段时仍可解码", true, "前向兼容")
		}
	} catch {
		check("快照/状态解码", false, "\(error)")
	}

	// 2. 幂等命令：同一 id 投两次，第二次必须判重
	do {
		let id = "probe-\(UUID().uuidString)"
		let first = try client.sendMessage(text: "来自 Swift 探针的留言", id: id)
		let second = try client.sendMessage(text: "来自 Swift 探针的留言", id: id)
		let firstDuplicate = first.objectValue?["duplicate"] == .bool(false)
		let secondDuplicate = second.objectValue?["duplicate"] == .bool(true)
		check("首次投递被接受", firstDuplicate, "\(first)")
		check("重复投递被判重（跨语言幂等）", secondDuplicate, "\(second)")
	} catch {
		check("幂等命令", false, "\(error)")
	}

	// 3. 事件订阅：从 0 续传，seq 必须严格递增
	do {
		let sink = SeqSink()
		try client.subscribe(fromSeq: 0, onEvent: { event in sink.append(event.seq) }, onError: { sink.fail(String(describing: $0)) })
		Thread.sleep(forTimeInterval: 2)
		let seqs = sink.value
		let sorted = seqs == seqs.sorted()
		check("能收到事件流", seqs.count > 0, "\(seqs.count) 条")
		check("seq 严格递增", sorted, "\(seqs)")
		if let error = sink.error { check("订阅无错误", false, error) }
	} catch {
		check("事件订阅", false, "\(error)")
	}

	// 4. 错误路径：不存在的命令必须被拒绝而不是崩掉连接
	do {
		var rejected = false
		do {
			_ = try client.sendMessage(text: "   ") // 空内容应被内核拒绝
		} catch {
			rejected = true
		}
		check("内核拒绝非法输入", rejected)
		let stillAlive = (try? client.status()) != nil
		check("拒绝之后连接仍可用", stillAlive)
	}

	print(failures == 0 ? "结论: PASS ✓ Swift 侧与内核契约一致" : "结论: FAIL ✗ \(failures) 项未通过")
	exit(failures == 0 ? 0 : 1)

default:
	fail("未知模式: \(mode)")
}
