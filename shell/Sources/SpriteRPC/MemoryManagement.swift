import Foundation

public struct MemoryFileSummary: Decodable, Identifiable, Sendable {
	public let path: String
	public let version: String
	public let bytes: Int
	public var id: String { path }
}

public struct MemoryFileList: Decodable, Sendable {
	public let files: [MemoryFileSummary]
}

public struct MemoryVersionSummary: Decodable, Identifiable, Sendable {
	public let version: String
	public let bytes: Int
	public let recordedAt: String?
	public let requestId: String?
	public let kind: String
	public let current: Bool
	public var id: String { version }
}

public struct MemoryVersionList: Decodable, Sendable {
	public let path: String
	public let currentVersion: String
	public let versions: [MemoryVersionSummary]
}

public struct MemoryPreview: Decodable, Sendable {
	public let path: String
	public let version: String
	public let content: String?
}

public struct MemoryAgreement: Decodable, Identifiable, Sendable {
	public let id: String
	public let text: String
	public let kind: String
	public let status: String
	public let createdAt: String
	public let activatedAt: String?
	public let expiresAt: String?
	public let revokedAt: String?
}

public struct MemoryAgreements: Decodable, Sendable {
	public struct Legacy: Decodable, Sendable {
		public let path: String
		public let content: String?
		public let version: String
	}
	public let revision: String
	public let items: [MemoryAgreement]
	public let legacy: Legacy
}
