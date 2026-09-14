import Foundation

/// 回到主线程改主线程隔离的状态。
///
/// 为什么需要它：`DispatchQueue.main.async` 的闭包在 Swift 并发模型里**不是** main-actor
/// 隔离的，所以在 `@MainActor` 的类型里直接写 `DispatchQueue.main.async { self.x = 1 }`
/// 会在 Swift 6 下报错（"main actor-isolated property can not be mutated from a nonisolated
/// context"，886 条告警里有 100 条是它）。
///
/// 这个包装把"我确实在主队列上"这件事说清楚：
///   - 已经在主线程 → 直接 `assumeIsolated` 执行（不额外派发，省一次调度）；
///   - 不在 → 派发到主队列后 `assumeIsolated`。
///
/// `assumeIsolated` 在"其实不在主线程"时会崩——所以只能用在**确实**是主队列的路径上，
/// 这也是它比 `Task { @MainActor }` 更诚实的地方：不掩盖线程错误。
@inline(__always)
func onMain(_ work: @escaping @MainActor @Sendable () -> Void) {
	if Thread.isMainThread {
		MainActor.assumeIsolated { work() }
	} else {
		DispatchQueue.main.async {
			MainActor.assumeIsolated { work() }
		}
	}
}
