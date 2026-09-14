import Darwin
import Foundation

/// 本地 RPC 客户端：Unix domain socket + 行分隔 JSON。
///
/// 外壳只通过这里接触内核——它不读记忆文件、不猜状态。
/// 两条连接各司其职：请求/响应一条，事件订阅一条（订阅会被长期占用）。
/// 线程安全说明：所有请求都经 `requestLock` 串行化；`LineConnection` 自己也有锁。
/// 外壳会在后台队列上发请求，所以这里**必须**是 Sendable——否则 Swift 6 会拦下
/// 每一处"后台队列里调用 client"的代码（886 条告警里很大一部分源于此）。
public final class CoreClient: @unchecked Sendable {
	public let socketPath: String
	private let requestConnection: LineConnection
	private let requestLock = NSLock()
	private var subscription: Subscription?

	public init(socketPath: String) throws {
		self.socketPath = socketPath
		self.requestConnection = try LineConnection(socketPath: socketPath)
	}

	public func close() {
		subscription?.cancel()
		subscription = nil
		requestConnection.close()
	}

	// MARK: - 查询

	public func snapshot() throws -> KernelSnapshot {
		let result = try request(type: "query.snapshot")
		return try decode(KernelSnapshot.self, from: result)
	}

	public func status() throws -> KernelState {
		let result = try request(type: "query.status")
		return try decode(KernelState.self, from: result)
	}

	// MARK: - 命令（必须幂等：id 由调用方生成，重试不会产生第二次副作用）

	@discardableResult
	public func sendMessage(text: String, source: String = "text", id: String = UUID().uuidString) throws -> JSONValue {
		try request(type: "command", command: ["id": id, "type": "message.send", "text": text, "source": source])
	}

	@discardableResult
	public func wakeNow(id: String = UUID().uuidString) throws -> JSONValue {
		try request(type: "command", command: ["id": id, "type": "wake.now"])
	}

	/// 让它安静一段时间：`hour`（一小时）/ `tonight`（到明早）/ `manual`（直到你手动继续）
	@discardableResult
	public func pause(until: String, id: String = UUID().uuidString) throws -> JSONValue {
		try request(type: "command", command: ["id": id, "type": "breath.pause", "until": until])
	}

	@discardableResult
	public func resume(id: String = UUID().uuidString) throws -> JSONValue {
		try request(type: "command", command: ["id": id, "type": "breath.resume"])
	}

	/// 原始请求（给不被常用路径覆盖的查询用，例如记录读取）
	public func requestRaw(_ payload: [String: Any]) throws -> JSONValue {
		try requestEnvelope(payload)
	}

	// MARK: - 事件订阅

	/// 从 fromSeq 之后续传；断线重连只要再调一次即可，不重不漏由内核保证。
	public func subscribe(fromSeq: Int, onEvent: @escaping @Sendable (SpriteEvent) -> Void, onError: @escaping @Sendable (Error) -> Void) throws {
		subscription?.cancel()
		subscription = try Subscription(socketPath: socketPath, fromSeq: fromSeq, onEvent: onEvent, onError: onError)
	}

	// MARK: - 内部

	private func request(type: String, command: [String: Any]? = nil) throws -> JSONValue {
		var payload: [String: Any] = ["id": UUID().uuidString, "type": type, "protocolVersion": protocolVersion]
		if let command { payload["command"] = command }
		return try requestEnvelope(payload)
	}

	private func requestEnvelope(_ payload: [String: Any]) throws -> JSONValue {
		// 串行化：读模型刷新可能在后台线程发生，请求/响应不能被交错
		requestLock.lock()
		defer { requestLock.unlock() }
		let sentId = payload["id"] as? String
		try requestConnection.send(payload)

		guard let line = try requestConnection.readLine() else {
			throw CoreClientError.connectionClosed
		}
		let response: RPCResponse
		do {
			response = try JSONDecoder().decode(RPCResponse.self, from: Data(line.utf8))
		} catch {
			// 解不开说明这条流已经错位了：关掉连接重连，别把半截响应当成下一条的结果
			requestConnection.close()
			throw CoreClientError.desynced("响应无法解析：\(error)")
		}
		// **必须比对 id**：内核偶尔比外壳的超时慢（例如它去跑 pi --list-models），
		// 迟到的响应会留给下一个请求；而 KernelState 是逐字段容错解码的，
		// 错配会"成功"解出全默认状态——界面显示"它睡着了 + 记录全空"。
		if let sentId, response.id != sentId {
			requestConnection.close()
			throw CoreClientError.desynced("响应 id 不匹配（发出 \(sentId)，收到 \(response.id)）")
		}
		if !response.ok {
			throw CoreClientError.rejected(response.error ?? "内核拒绝了请求")
		}
		return response.result ?? .null
	}

	private func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
		let data = try JSONEncoder().encode(value)
		return try JSONDecoder().decode(type, from: data)
	}
}

public enum CoreClientError: Error, CustomStringConvertible {
	case socketFailure(String)
	case connectionClosed
	case rejected(String)
	case timedOut
	/// 响应与请求对不上（id 不匹配 / 解不开）：这条流已经错位，必须重连
	case desynced(String)

	public var description: String {
		switch self {
		case .socketFailure(let message): return "连接内核失败: \(message)"
		case .connectionClosed: return "内核连接已关闭"
		case .rejected(let message): return "内核拒绝: \(message)"
		case .timedOut: return "内核响应超时"
		case .desynced(let message): return "内核响应错位：\(message)"
		}
	}
}

// MARK: - 行连接

/// 线程安全说明：`lock` 保护 buffer 与 fd；`readLine` 在同一把锁里读写。
/// `close()` 不取锁是**故意的**：它要在阻塞读卡住时把 fd 关掉让读返回——
/// 取锁会死锁。fd 置 -1 后老 reader 不会再读到新连接的字节（fd 号复用由 close 的顺序避免）。
final class LineConnection: @unchecked Sendable {
	private var fd: Int32 = -1
	private var buffer = Data()
	private let lock = NSLock()

	init(socketPath: String, timeoutSeconds: Int = 10) throws {
		fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { throw CoreClientError.socketFailure("socket() 失败") }

		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let pathBytes = Array(socketPath.utf8)
		guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
			throw CoreClientError.socketFailure("socket 路径过长: \(socketPath)")
		}
		withUnsafeMutablePointer(to: &address.sun_path) { pointer in
			pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
				for (index, byte) in pathBytes.enumerated() { destination[index] = CChar(bitPattern: byte) }
				destination[pathBytes.count] = 0
			}
		}

		let size = socklen_t(MemoryLayout<sockaddr_un>.size)
		let connected = withUnsafePointer(to: &address) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
		}
		guard connected == 0 else {
			let message = String(cString: strerror(errno))
			Darwin.close(fd)
			throw CoreClientError.socketFailure(message)
		}

		var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
	}

	func send(_ object: [String: Any]) throws {
		let data = try JSONSerialization.data(withJSONObject: object)
		var payload = data
		payload.append(0x0a)
		try payload.withUnsafeBytes { raw in
			var offset = 0
			while offset < raw.count {
				let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
				if written <= 0 { throw CoreClientError.connectionClosed }
				offset += written
			}
		}
	}

	/// 读一行（严格按 LF 切分，与内核的 framing 约定一致）。返回 nil 表示对端关闭。
	func readLine() throws -> String? {
		lock.lock()
		defer { lock.unlock() }
		while true {
			if let index = buffer.firstIndex(of: 0x0a) {
				let line = buffer[buffer.startIndex..<index]
				buffer.removeSubrange(buffer.startIndex...index)
				return String(decoding: line, as: UTF8.self)
			}
			var chunk = [UInt8](repeating: 0, count: 8192)
			let count = read(fd, &chunk, chunk.count)
			if count == 0 { return nil }
			if count < 0 {
				if errno == EAGAIN || errno == EWOULDBLOCK {
					// 读超时：这条连接上可能还有一条迟到的响应在途。
					// 只抛错不关连接，下一条请求就会读到它（错配）。
					buffer.removeAll(keepingCapacity: false)
					close()
					throw CoreClientError.timedOut
				}
				throw CoreClientError.socketFailure(String(cString: strerror(errno)))
			}
			buffer.append(contentsOf: chunk[0..<count])
		}
	}

	func close() {
		if fd >= 0 {
			Darwin.close(fd)
			fd = -1
		}
	}
}

// MARK: - 订阅

/// 线程安全说明：`cancelled` 与 `connection` 只在 `queue` 上访问（加上 close 路径的互斥）。
public final class Subscription: @unchecked Sendable {
	private let connection: LineConnection
	private let queue = DispatchQueue(label: "sprite.rpc.subscription")
	private var cancelled = false

	init(socketPath: String, fromSeq: Int, onEvent: @escaping @Sendable (SpriteEvent) -> Void, onError: @escaping @Sendable (Error) -> Void) throws {
		connection = try LineConnection(socketPath: socketPath, timeoutSeconds: 0)
		try connection.send(["id": UUID().uuidString, "type": "events.subscribe", "fromSeq": fromSeq, "protocolVersion": protocolVersion])

		queue.async { [connection] in
			while !self.cancelled {
				do {
					// EOF（内核退出/被杀）也必须当成断开上报。
					// 早先这里直接 return —— 于是外壳永远不会知道内核已经不在了（静默失联）。
					guard let line = try connection.readLine(), !line.isEmpty else {
						if !self.cancelled { onError(CoreClientError.connectionClosed) }
						return
					}
					let event = try JSONDecoder().decode(SpriteEvent.self, from: Data(line.utf8))
					onEvent(event)
				} catch {
					if !self.cancelled { onError(error) }
					return
				}
			}
		}
	}

	public func cancel() {
		cancelled = true
		connection.close()
	}
}
