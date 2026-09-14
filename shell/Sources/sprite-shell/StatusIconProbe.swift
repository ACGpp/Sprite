import AppKit
import SpriteRPC

/// 自检用：把菜单栏图标单独拎出来画，验证"它会呼吸、会随状态变色"。
/// 图标逻辑原本藏在 AppDelegate 里，那样没法在不开窗口的情况下断言。
final class StatusIconProbe {
	func icon(phase: Double, presence: PresenceState) -> NSImage {
		let size = NSSize(width: 18, height: 18)
		return NSImage(size: size, flipped: false) { _ in
			let pulse = 0.5 + 0.5 * sin(phase * 2 * .pi)
			let color: NSColor
			switch presence {
			case .thinking: color = NSColor(calibratedRed: 0.73, green: 0.63, blue: 0.85, alpha: 1)
			case .quiet, .paused: color = NSColor(calibratedWhite: 0.55, alpha: 1)
			case .degraded: color = NSColor(calibratedRed: 0.84, green: 0.72, blue: 0.43, alpha: 1)
			default: color = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
			}
			let ring = NSBezierPath(ovalIn: NSRect(x: 2.5, y: 2.5, width: 13, height: 13))
			ring.lineWidth = 1.2
			color.withAlphaComponent(0.35 + 0.45 * pulse).setStroke()
			ring.stroke()
			let radius = 2.0 + 1.6 * pulse
			let dot = NSBezierPath(ovalIn: NSRect(x: 9 - radius, y: 9 - radius, width: radius * 2, height: radius * 2))
			color.withAlphaComponent(0.55 + 0.45 * pulse).setFill()
			dot.fill()
			return true
		}
	}
}
