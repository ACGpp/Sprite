import Foundation

/// 任意 JSON 值。内核的事件 data / 读模型字段未来还会长，外壳必须能容忍未知字段，
/// 而不是解码失败就整块界面空白。
public enum JSONValue: Codable, Equatable, Sendable {
	case string(String)
	case number(Double)
	case bool(Bool)
	case object([String: JSONValue])
	case array([JSONValue])
	case null

	public init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode([String: JSONValue].self) {
			self = .object(value)
		} else if let value = try? container.decode([JSONValue].self) {
			self = .array(value)
		} else {
			throw DecodingError.dataCorruptedError(in: container, debugDescription: "无法识别的 JSON 值")
		}
	}

	public func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .string(let value): try container.encode(value)
		case .number(let value): try container.encode(value)
		case .bool(let value): try container.encode(value)
		case .object(let value): try container.encode(value)
		case .array(let value): try container.encode(value)
		case .null: try container.encodeNil()
		}
	}

	public var stringValue: String? {
		if case .string(let value) = self { return value }
		return nil
	}

	public var numberValue: Double? {
		if case .number(let value) = self { return value }
		return nil
	}

	public var boolValue: Bool? {
		if case .bool(let value) = self { return value }
		return nil
	}

	public var arrayValue: [JSONValue]? {
		if case .array(let value) = self { return value }
		return nil
	}

	public var objectValue: [String: JSONValue]? {
		if case .object(let value) = self { return value }
		return nil
	}
}
