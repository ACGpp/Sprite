import AppKit
import Carbon.HIToolbox

/// 全局快捷键：随处按一下就打开面板说话。
///
/// 用 Carbon 的 `RegisterEventHotKey` 而不是 `NSEvent` 全局监听——
/// 前者**不需要辅助功能权限**（后者会再弹一次系统授权）。
///
/// 默认 **⌥K**（两个键，和 ⌘K 一样短）。用户说 ⌃⌥⌘Space 那种"太长了"。
enum HotKey {
	static let optionK: (keyCode: UInt32, modifiers: UInt32) = (UInt32(kVK_ANSI_K), UInt32(optionKey))

	/// 注册快捷键，返回是否成功（失败通常是被别的应用占了）。
	///
	/// 主线程隔离：Carbon 的热键事件挂在主运行循环上，注册与处理都只该在主线程。
	@discardableResult
	@MainActor
	static func register(
		keyCode: UInt32 = optionK.keyCode,
		modifiers: UInt32 = optionK.modifiers,
		handler: @escaping () -> Void
	) -> Bool {
		var hotKeyRef: EventHotKeyRef?
		let hotKeyID = EventHotKeyID(signature: OSType(0x53505254), id: 1) // 'SPRT'
		let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
		guard status == noErr, hotKeyRef != nil else { return false }

		// 事件处理器：Carbon 用 C 回调，所以把闭包挂在一个静态存储里
		HotKeyStorage.shared.handler = handler
		var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
		InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
			var pressedID = EventHotKeyID()
			GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
			                  MemoryLayout<EventHotKeyID>.size, nil, &pressedID)
			if pressedID.signature == OSType(0x53505254) {
				HotKeyStorage.shared.handler?()
			}
			return noErr
		}, 1, &spec, nil, nil)
		return true
	}

	/// 给界面显示用的名字
	static var displayName: String { "⌥K" }
}

/// 热键回调只可能在主线程触发（Carbon 的事件处理挂在主运行循环上），
/// 所以这个单例按主线程隔离——Swift 6 需要看到这句话，而不是默认"谁都能碰"。
@MainActor
private final class HotKeyStorage {
	static let shared = HotKeyStorage()
	var handler: (() -> Void)?
}
