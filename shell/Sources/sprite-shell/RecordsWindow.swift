import AppKit
import SwiftUI

/// 记录窗口的**唯一**构造点。
///
/// 为什么必须唯一：有一类问题（布局死循环）**只在真实窗口里**才出现——
/// 离屏渲染（`--shot`）不会触发。所以真实应用与 `--hang-check` 必须走同一条构造路径，
/// 否则检查器检的是另一套配置，等于没检。
enum RecordsWindow {
	/// 建一个记录窗口（不显示）。
	static func make(model: ShellModel, section: RecordsView.Section) -> NSWindow {
		let controller = NSHostingController(rootView: RecordsView(model: model, initialSection: section))
		// **窗口不跟着内容尺寸走**。NSHostingController 默认把内容的 preferredContentSize
		// 反馈给窗口，窗口一变大内容又重排——两边互追就是无限布局循环
		// （实证：AppKit 日志 `layoutSubtreeIfNeeded ... has continued for 300 iterations`，
		//  主线程采样全在 NSHostingView.layout() 里）。
		controller.sizingOptions = []
		let window = NSWindow(contentViewController: controller)
		window.title = L("它的记录")
		window.setContentSize(NSSize(width: 900, height: 580))
		window.styleMask = [.titled, .closable, .resizable]
		window.isReleasedWhenClosed = false
		window.center()
		return window
	}
}
