import Foundation
import ServiceManagement

/// 登录自启（应用自己）。
///
/// 用系统的 `SMAppService`：这是 macOS 13+ 的官方做法，登录项会出现在
/// 「系统设置 → 通用 → 登录项」里，用户随时能自己关掉——**不偷偷摸摸加东西**。
///
/// 内核是另一个进程，由 launchd 通过 `~/Library/LaunchAgents/com.sprite.core.plist`
/// 常驻（`Scripts/install.sh` 装它）。两者合起来才是"开机就在"：
/// 登录 → launchd 拉起内核 → 登录项拉起这个菜单栏应用。
public enum LoginItem {
	public enum Status: Equatable {
		case enabled
		case disabled
		/// 已注册但用户/系统还需要在设置里点一下同意
		case requiresApproval
		/// 没找到（应用不在可注册的位置，比如还在构建目录里直接跑）
		case unavailable(String)

		public var isOn: Bool { self == .enabled }

		public var describe: String {
			switch self {
			case .enabled: return L("登录时会自动打开")
			case .disabled: return L("登录时不会自动打开")
			case .requiresApproval: return L("已登记，等你在「系统设置 → 通用 → 登录项」里允许")
			case .unavailable(let reason): return "这台机器上用不了：\(reason)"
			}
		}
	}

	public static func status() -> Status {
		guard #available(macOS 13.0, *) else { return .unavailable(L("系统版本太旧（需要 macOS 13+）")) }
		let service = SMAppService.mainApp
		switch service.status {
		case .enabled: return .enabled
		case .notRegistered: return .disabled
		case .requiresApproval: return .requiresApproval
		case .notFound: return .unavailable(L("系统没找到这个应用（先把它放进「应用程序」再试）"))
		@unknown default: return .unavailable(L("未知状态"))
		}
	}

	/// 开或关。返回**操作之后**的真实状态，以及失败原因（如实回报，不假装成功）。
	public static func setEnabled(_ enabled: Bool) -> (Status, String?) {
		guard #available(macOS 13.0, *) else { return (.unavailable(L("系统版本太旧（需要 macOS 13+）")), nil) }
		let service = SMAppService.mainApp
		do {
			if enabled {
				try service.register()
			} else {
				try service.unregister()
			}
			return (status(), nil)
		} catch {
			return (status(), error.localizedDescription)
		}
	}

	/// 内核常驻服务的状态（看 launchd 的 plist 在不在）
	public static func kernelServiceInstalled() -> Bool {
		let plist = FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Library/LaunchAgents/com.sprite.core.plist")
		return FileManager.default.fileExists(atPath: plist.path)
	}
}
