import Foundation

/// 它说话了，该不该弹那张居中的卡片？
///
/// 唯一的判据是：**用户是不是真的正看着这场对话**。
///
/// 规则来自两次真实反馈：
///   1. "他回我的时候还会弹一个弹窗，但其实他在面板上已经回复我了" ——
///      面板就在眼前时不该重复弹；
///   2. "我给他发了消息，他回复我的时候并没有弹窗" ——
///      老实现把"窗口开着"当成"你在看"：记录窗口开在「现在」页但被别的
///      app 盖住、或者你切走去干别的，它依然不弹，于是回复根本没人看见。
///
/// 所以抑制必须同时满足"窗口在屏幕上是可见的"**且**"当前 app 是激活的"；
/// 只要你去用别的 app 了，就该弹——卡片设了 nonactivating + 置顶 + 全空间可见，
/// 正是为了在你不在它面前时把话送到眼前。
public enum SpeakingPolicy {
	/// - Parameters:
	///   - panelShown: 下拉面板开着（`NSPopover.isShown`）
	///   - appActive: 当前是否激活（`NSApp.isActive`）
	///   - recordsLiveOnScreen: 记录窗口的「现在」页真的在屏幕上（可见且未被遮挡）
	public static func shouldShowCard(panelShown: Bool, appActive: Bool, recordsLiveOnScreen: Bool) -> Bool {
		// 你正在用别的 app：一定弹（这正是卡片存在的意义）
		guard appActive else { return true }
		if panelShown { return false }
		if recordsLiveOnScreen { return false }
		return true
	}
}
