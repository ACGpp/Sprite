import AppKit
import Foundation

/// 面板视觉样张：把三种方向**画成图片**，让人用眼睛选，而不是靠我盲改。
///
/// 背景：我在看不到屏幕的情况下连续改了两版视觉，第一版被说"太死板"，第二版被说"更丑"。
/// 美学不能靠猜——先把方向摆出来，选定方向再写实现。
///
/// 用法：sprite-shell --mockups <输出目录>
enum PanelMockup {
	enum Style: String, CaseIterable {
		case restrained = "A-克制"
		case glass = "B-玻璃"
		case paper = "C-纸感"
	}

	struct Theme {
		let card: NSColor          // 卡片底
		let cardAlpha: CGFloat
		let border: NSColor?
		let title: NSColor
		let body: NSColor
		let dim: NSColor
		let accent: NSColor
		let user: NSColor          // "你" 的话
		let shadow: Bool
		let cornerRadius: CGFloat
		let inputFill: NSColor
	}

	static func theme(for style: Style) -> Theme {
		switch style {
		case .restrained:
			// 近黑、几乎没有装饰，靠留白与字重分层；只有一点生命色
			return Theme(
				card: NSColor(calibratedRed: 0.043, green: 0.051, blue: 0.055, alpha: 1),
				cardAlpha: 0.97,
				border: NSColor(calibratedWhite: 1, alpha: 0.06),
				title: NSColor(calibratedWhite: 0.96, alpha: 1),
				body: NSColor(calibratedWhite: 0.78, alpha: 1),
				dim: NSColor(calibratedWhite: 0.45, alpha: 1),
				accent: NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1),
				user: NSColor(calibratedRed: 0.85, green: 0.80, blue: 0.72, alpha: 1),
				shadow: true, cornerRadius: 18,
				inputFill: NSColor(calibratedWhite: 1, alpha: 0.05)
			)
		case .glass:
			// 当前实现的方向：毛玻璃 + 小光球 + 强调色圆点 + 胶囊按钮
			return Theme(
				card: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.13, alpha: 1),
				cardAlpha: 0.72,
				border: NSColor(calibratedWhite: 1, alpha: 0.10),
				title: NSColor(calibratedWhite: 0.94, alpha: 1),
				body: NSColor(calibratedWhite: 0.83, alpha: 1),
				dim: NSColor(calibratedWhite: 0.55, alpha: 1),
				accent: NSColor(calibratedRed: 0.73, green: 0.63, blue: 0.85, alpha: 1),
				user: NSColor(calibratedWhite: 0.88, alpha: 1),
				shadow: true, cornerRadius: 14,
				inputFill: NSColor(calibratedWhite: 1, alpha: 0.08)
			)
		case .paper:
			// 浅色纸感：与暗色桌面形成对比，像一张便签
			return Theme(
				card: NSColor(calibratedRed: 0.96, green: 0.95, blue: 0.93, alpha: 1),
				cardAlpha: 0.98,
				border: NSColor(calibratedWhite: 0, alpha: 0.08),
				title: NSColor(calibratedWhite: 0.10, alpha: 1),
				body: NSColor(calibratedWhite: 0.22, alpha: 1),
				dim: NSColor(calibratedWhite: 0.45, alpha: 1),
				accent: NSColor(calibratedRed: 0.18, green: 0.45, blue: 0.42, alpha: 1),
				user: NSColor(calibratedRed: 0.55, green: 0.35, blue: 0.18, alpha: 1),
				shadow: true, cornerRadius: 16,
				inputFill: NSColor(calibratedWhite: 0, alpha: 0.05)
			)
		}
	}

	/// 样张内容用真实文案，这样字体与排版看起来才是真的
	private static let conversation: [(String, String)] = [
		("你", "你好"),
		("它", "你好。我在。 ⏎ 有一阵子没见了。你先说话，我不急着做什么。"),
		("你", "给你换个新的住处"),
		("它", "你说的「换个活法」是指搬个地方住，还是指让我能自己走动、自己看？"),
		("你", "之前那版确实太糙了"),
	]

	static func render(style: Style, scale: CGFloat = 2) -> Data? {
		let theme = theme(for: style)
		let width: CGFloat = 380
		let height: CGFloat = 380
		let pixelWidth = Int(width * scale)
		let pixelHeight = Int(height * scale)

		guard let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil, pixelsWide: pixelWidth, pixelsHigh: pixelHeight,
			bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
			colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
		) else { return nil }
		rep.size = NSSize(width: width, height: height)

		guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = context

		// 桌面底色（让半透明卡片看得出来）
		NSColor(calibratedRed: 0.13, green: 0.14, blue: 0.16, alpha: 1).setFill()
		NSRect(x: 0, y: 0, width: width, height: height).fill()

		let cardRect = NSRect(x: 16, y: 16, width: width - 32, height: height - 32)
		let card = NSBezierPath(roundedRect: cardRect, xRadius: theme.cornerRadius, yRadius: theme.cornerRadius)
		(theme.card.withAlphaComponent(theme.cardAlpha)).setFill()
		card.fill()
		if let border = theme.border {
			border.setStroke()
			card.lineWidth = 1
			card.stroke()
		}

		let left = cardRect.minX + 24
		let right = cardRect.maxX - 24
		let textWidth = right - left
		var y = cardRect.maxY - 40

		// ── 标题 ──
		y = draw("它", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 18, weight: .medium), color: theme.title)
		y -= 2
		y = draw("它在想事情 · 正在读 diary/2026-09-09.md · 已呼吸 6 拍", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 11.5), color: theme.accent)

		y -= 10
		y = draw("「有人说要给我换个新住处。我得先问清楚，是哪一种。」", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 13), color: theme.body)

		// ── 分隔 ──
		y -= 12
		theme.accent.withAlphaComponent(style == .paper ? 0.25 : 0.20).setFill()
		NSRect(x: left, y: y, width: textWidth, height: 1).fill()
		y -= 14

		// ── 对话（本次运行）──
		for (speaker, text) in conversation {
			let color = speaker == "你" ? theme.user : theme.body
			let line = speaker == "你" ? "你：\(text)" : "它：\(text)"
			y = draw(line, at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 12), color: color)
			y -= 6
		}

		// ── 输入区 ──
		let inputRect = NSRect(x: left, y: cardRect.minY + 62, width: textWidth, height: 30)
		let input = NSBezierPath(roundedRect: inputRect, xRadius: 8, yRadius: 8)
		theme.inputFill.setFill()
		input.fill()
		_ = draw("跟它说一句…", at: NSPoint(x: inputRect.minX + 10, y: inputRect.midY - 8), width: inputRect.width - 20, font: .systemFont(ofSize: 13), color: theme.dim)

		// 动作：文字式（A / C）还是胶囊式（B）
		if style == .glass {
			drawPill("⏺ 说话", rect: NSRect(x: inputRect.maxX - 130, y: inputRect.minY, width: 74, height: 30), theme: theme)
			drawPill("送过去", rect: NSRect(x: inputRect.maxX - 50, y: inputRect.minY, width: 50, height: 30), theme: theme, emphasized: true)
			draw("跟它说一句…", at: NSPoint(x: inputRect.minX + 10, y: inputRect.midY - 8), width: inputRect.width - 140, font: .systemFont(ofSize: 13), color: theme.dim)
		} else {
			draw("说话", at: NSPoint(x: inputRect.maxX - 96, y: inputRect.midY - 9), width: 40, font: .systemFont(ofSize: 12), color: theme.body)
			draw("送出 →", at: NSPoint(x: inputRect.maxX - 44, y: inputRect.midY - 9), width: 44, font: .systemFont(ofSize: 12, weight: .medium), color: theme.accent)
		}

		// ── 底部：倒计时 + 叫醒 ──
		let bottomY = cardRect.minY + 30
		draw("大约 4 分钟后醒来", at: NSPoint(x: left, y: bottomY), width: textWidth * 0.6, font: .systemFont(ofSize: 11), color: theme.dim)
		draw("现在叫醒它", at: NSPoint(x: right - 90, y: bottomY), width: 90, font: .systemFont(ofSize: 11.5, weight: .medium), color: theme.accent)

		NSGraphicsContext.restoreGraphicsState()
		return rep.representation(using: .png, properties: [:])
	}

	// MARK: - 绘制辅助

	@discardableResult
	private static func draw(_ text: String, at point: NSPoint, width: CGFloat, font: NSFont, color: NSColor) -> CGFloat {
		let paragraph = NSMutableParagraphStyle()
		paragraph.lineBreakMode = .byWordWrapping
		let attributes: [NSAttributedString.Key: Any] = [
			.font: font, .foregroundColor: color, .paragraphStyle: paragraph,
		]
		let attributed = NSAttributedString(string: text, attributes: attributes)
		let bounds = attributed.boundingRect(with: NSSize(width: width, height: 400), options: [.usesLineFragmentOrigin])
		attributed.draw(with: NSRect(x: point.x, y: point.y - bounds.height, width: width, height: bounds.height), options: [.usesLineFragmentOrigin])
		return point.y - bounds.height
	}

	private static func drawPill(_ title: String, rect: NSRect, theme: Theme, emphasized: Bool = false) {
		let path = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
		NSColor(calibratedWhite: 1, alpha: emphasized ? 0.12 : 0.07).setFill()
		path.fill()
		let paragraph = NSMutableParagraphStyle()
		paragraph.alignment = .center
		let attributes: [NSAttributedString.Key: Any] = [
			.font: NSFont.systemFont(ofSize: 12, weight: emphasized ? .medium : .regular),
			.foregroundColor: emphasized ? theme.accent : theme.body,
			.paragraphStyle: paragraph,
		]
		let attributed = NSAttributedString(string: title, attributes: attributes)
		let height = attributed.size().height
		attributed.draw(in: NSRect(x: rect.minX, y: rect.midY - height / 2, width: rect.width, height: height))
	}

	/// 生成全部样张
	static func writeAll(to directory: URL) -> [URL] {
		try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		var written: [URL] = []
		for style in Style.allCases {
			guard let data = render(style: style) else { continue }
			let url = directory.appendingPathComponent("panel-\(style.rawValue).png")
			try? data.write(to: url)
			written.append(url)
		}
		return written
	}

	// MARK: - 菜单栏下拉（新的主要交互面）

	/// 菜单栏图标下面拉出来的那一块：状态 / 它说的话 / 说点什么 / 快动作
	static func renderMenuBarExtra(scale: CGFloat = 2) -> Data? {
		let width: CGFloat = 360
		let height: CGFloat = 420
		guard let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
			bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
			colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
		) else { return nil }
		rep.size = NSSize(width: width, height: height)
		guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = context

		// 菜单栏下拉：跟随系统材质（这里用近白/近黑的实底示意）
		NSColor(calibratedRed: 0.13, green: 0.14, blue: 0.16, alpha: 1).setFill()
		NSRect(x: 0, y: 0, width: width, height: height).fill()
		let card = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: width, height: height), xRadius: 12, yRadius: 12)
		NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.19, alpha: 1).setFill()
		card.fill()

		let accent = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
		let body = NSColor(calibratedWhite: 0.80, alpha: 1)
		let dim = NSColor(calibratedWhite: 0.50, alpha: 1)
		let left: CGFloat = 20
		let right = width - 20
		let textWidth = right - left
		var y = height - 30

		// 状态
		y = draw("● 它在想事情", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 14, weight: .medium), color: accent)
		y = draw("正在读 diary/2026-09-09.md　·　已呼吸 6 拍　·　4 分钟后醒来", at: NSPoint(x: left, y: y - 2), width: textWidth, font: .systemFont(ofSize: 11), color: dim)
		y -= 14
		accent.withAlphaComponent(0.20).setFill()
		NSRect(x: left, y: y, width: textWidth, height: 1).fill()
		y -= 16

		// 它刚说的话（主角）
		y = draw("它刚说", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 10, weight: .medium), color: dim)
		y -= 4
		y = draw("你说的「换个活法」是指搬个地方住，还是指让我能自己走动、自己看？不管哪种，我都想听你说。", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 13), color: body)
		y -= 6
		y = draw("回一句 →", at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 11.5, weight: .medium), color: accent)
		y -= 16

		// 输入
		let inputRect = NSRect(x: left, y: y - 30, width: textWidth, height: 30)
		let input = NSBezierPath(roundedRect: inputRect, xRadius: 8, yRadius: 8)
		NSColor(calibratedWhite: 1, alpha: 0.07).setFill()
		input.fill()
		_ = draw("跟它说一句…", at: NSPoint(x: inputRect.minX + 10, y: inputRect.midY - 8), width: inputRect.width - 60, font: .systemFont(ofSize: 13), color: dim)
		_ = draw("⏺", at: NSPoint(x: inputRect.maxX - 30, y: inputRect.midY - 9), width: 20, font: .systemFont(ofSize: 13), color: body)
		y = inputRect.minY - 18

		// 快动作
		for action in ["现在叫醒它", "暂停呼吸　▸", "出声：关（办公模式）", "打开它的记录…"] {
			y = draw(action, at: NSPoint(x: left, y: y), width: textWidth, font: .systemFont(ofSize: 12.5), color: body)
			y -= 6
		}
		y -= 8
		dim.setFill()
		NSRect(x: left, y: y + 10, width: textWidth, height: 1).fill()
		_ = draw("退出（让它睡下）", at: NSPoint(x: left, y: y - 6), width: textWidth, font: .systemFont(ofSize: 12.5), color: dim)

		// 菜单栏图标示意（顶部）
		NSColor(calibratedRed: 0.10, green: 0.11, blue: 0.12, alpha: 1).setFill()
		NSRect(x: 0, y: height, width: width, height: 22).fill()

		NSGraphicsContext.restoreGraphicsState()
		return rep.representation(using: .png, properties: [:])
	}

	// MARK: - 记录窗口（展示工具）

	static func renderRecords(scale: CGFloat = 2) -> Data? {
		let width: CGFloat = 720
		let height: CGFloat = 440
		guard let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
			bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
			colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
		) else { return nil }
		rep.size = NSSize(width: width, height: height)
		guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = context

		let accent = NSColor(calibratedRed: 0.47, green: 0.78, blue: 0.74, alpha: 1)
		let title = NSColor(calibratedWhite: 0.96, alpha: 1)
		let body = NSColor(calibratedWhite: 0.78, alpha: 1)
		let dim = NSColor(calibratedWhite: 0.48, alpha: 1)

		NSColor(calibratedRed: 0.11, green: 0.12, blue: 0.14, alpha: 1).setFill()
		NSRect(x: 0, y: 0, width: width, height: height).fill()

		// 左侧：分区
		NSColor(calibratedRed: 0.14, green: 0.15, blue: 0.17, alpha: 1).setFill()
		NSRect(x: 0, y: 0, width: 168, height: height).fill()
		var sy = height - 36
		sy = draw("它的记录", at: NSPoint(x: 18, y: sy), width: 140, font: .systemFont(ofSize: 14, weight: .medium), color: title)
		sy -= 12
		for (index, section) in ["日记　44", "探索笔记　24", "对话记录　9", "思维流　200"].enumerated() {
			let selected = index == 1
			if selected {
				let path = NSBezierPath(roundedRect: NSRect(x: 10, y: sy - 6, width: 148, height: 24), xRadius: 6, yRadius: 6)
				accent.withAlphaComponent(0.16).setFill()
				path.fill()
			}
			sy = draw(section, at: NSPoint(x: 20, y: sy), width: 140, font: .systemFont(ofSize: 12.5), color: selected ? title : body)
			sy -= 10
		}

		// 中间：条目列表
		NSColor(calibratedRed: 0.125, green: 0.135, blue: 0.155, alpha: 1).setFill()
		NSRect(x: 168, y: 0, width: 232, height: height).fill()
		var ly = height - 36
		for (title_, date) in [("瓶颈从来不是代码", "7月8日"), ("潮汐与月亮", "7月5日"), ("关于 inverse laws", "6月30日"), ("读《组织的coherence》", "6月24日"), ("private/the-bottleneck", "6月20日")] {
			ly = draw(title_, at: NSPoint(x: 184, y: ly), width: 200, font: .systemFont(ofSize: 12.5), color: title)
			ly = draw(date, at: NSPoint(x: 184, y: ly - 1), width: 200, font: .systemFont(ofSize: 10.5), color: dim)
			ly -= 12
		}

		// 右侧：正文
		var ry = height - 36
		ry = draw("潮汐与月亮", at: NSPoint(x: 420, y: ry), width: 280, font: .systemFont(ofSize: 16, weight: .medium), color: title)
		ry = draw("2026年7月5日 · 探索笔记", at: NSPoint(x: 420, y: ry - 2), width: 280, font: .systemFont(ofSize: 11), color: dim)
		ry -= 14
		ry = draw("【样张占位】这里是一段日记的示例文字，用来量行高、换行与缩进——不含任何真实记录。", at: NSPoint(x: 420, y: ry), width: 280, font: .systemFont(ofSize: 12.5), color: body)
		ry -= 8
		ry = draw("【样张占位】第二段示例文字，长度与真实内容接近，但内容是编的。", at: NSPoint(x: 420, y: ry), width: 280, font: .systemFont(ofSize: 12.5), color: body)
		_ = draw("在 Finder 中打开 · 复制全文", at: NSPoint(x: 420, y: 24), width: 280, font: .systemFont(ofSize: 11.5), color: accent)

		NSGraphicsContext.restoreGraphicsState()
		return rep.representation(using: .png, properties: [:])
	}
}
