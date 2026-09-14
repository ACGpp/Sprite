import Foundation

/// 内核设置的**解码**（契约镜像的一部分）。
///
/// 为什么放在这个库而不是外壳里：它是"怎么读内核的回答"，属于契约镜像的职责；
/// 放在这里还有个实际好处——**测试 target 只依赖这个库**，于是这段解码逻辑
/// 能被真正的单元测试覆盖（外壳是 executable target，测试够不着）。
///
/// 容错原则与 `KernelState` 一致：逐字段读，缺字段用安全默认值，
/// 多余字段忽略——新外壳要能连旧内核，旧外壳也要能连新内核。
public struct KernelSettings: Sendable, Equatable {
	public var mode: String = "provider"
	public var provider: String?
	public var apiFormat: String?
	public var baseUrl: String?
	public var model: String?
	public var modelName: String?
	/// 密钥**只有"配没配"**：内核从不回显值，这里也一样
	public var hasApiKey = false
	public var providers: [Provider] = []
	public var apiFormats: [Format] = []
	public var quietStart = 23
	public var quietEnd = 7
	public var proactiveEnabled = true
	public var proactivePerDay = 2
	/// agent 的手脚档位：on / readonly / off（见 core/settings.ts）
	public var agentShell = "on"
	public var source = "default"
	public var piAvailable = false
	public var settingsPath = ""
	public var homeDir = ""

	public struct Provider: Sendable, Equatable {
		public let id: String
		public let label: String
		public let hint: String
	}
	public struct Format: Sendable, Equatable {
		public let id: String
		public let label: String
	}

	public init() {}

	public static func decode(_ value: JSONValue?) -> KernelSettings {
		var parsed = KernelSettings()
		guard let object = value?.objectValue else { return parsed }
		if let model = object["model"]?.objectValue {
			parsed.mode = model["mode"]?.stringValue ?? "provider"
			parsed.provider = model["provider"]?.stringValue
			parsed.apiFormat = model["apiFormat"]?.stringValue
			parsed.baseUrl = model["baseUrl"]?.stringValue
			parsed.model = model["model"]?.stringValue
			parsed.modelName = model["modelName"]?.stringValue
			parsed.hasApiKey = model["hasApiKey"]?.boolValue ?? false
		}
		parsed.providers = object["providers"]?.arrayValue?.compactMap { item in
			guard let entry = item.objectValue, let id = entry["id"]?.stringValue else { return nil }
			return Provider(id: id, label: entry["label"]?.stringValue ?? id, hint: entry["hint"]?.stringValue ?? "")
		} ?? []
		parsed.apiFormats = object["apiFormats"]?.arrayValue?.compactMap { item in
			guard let entry = item.objectValue, let id = entry["id"]?.stringValue else { return nil }
			return Format(id: id, label: entry["label"]?.stringValue ?? id)
		} ?? []
		if let quiet = object["quietHours"]?.objectValue {
			if let start = quiet["start"]?.numberValue { parsed.quietStart = Int(start) }
			if let end = quiet["end"]?.numberValue { parsed.quietEnd = Int(end) }
		}
		if let proactive = object["proactive"]?.objectValue {
			parsed.proactiveEnabled = proactive["enabled"]?.boolValue ?? true
			if let perDay = proactive["perDay"]?.numberValue { parsed.proactivePerDay = Int(perDay) }
		}
		if let security = object["security"]?.objectValue {
			parsed.agentShell = security["agentShell"]?.stringValue ?? "on"
		}
		parsed.source = object["source"]?.stringValue ?? "default"
		parsed.piAvailable = object["piAvailable"]?.boolValue ?? false
		parsed.settingsPath = object["settingsPath"]?.stringValue ?? ""
		parsed.homeDir = object["homeDir"]?.stringValue ?? ""
		return parsed
	}
}
