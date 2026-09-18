import Foundation

/// 界面语言。
///
/// 为什么用"中文原文当键"的词典，而不是标准的 key + strings 文件：
/// 这个应用的所有文案都是内联中文写死的（400 条左右）。用原文当键可以**增量翻译**——
/// 没进词典的字符串自动回落中文，不会出现空白或 `key.notFound`，
/// 也就不必一次性把所有界面都翻完才能上线英文模式。
public enum UILanguage: String, CaseIterable, Sendable {
	case auto
	case zh
	case en

	/// 设置页里的显示名（两种语言都写出来，谁都能认出自己那一项）
	public var label: String {
		switch self {
		case .auto: return "跟随系统 / Follow system"
		case .zh: return "中文"
		case .en: return "English"
		}
	}
}

public enum Loc {
	public static let defaultsKey = "sprite.uiLanguage"

	/// 当前语言设置（`.auto` 时看系统语言）。
	///
	/// `nonisolated(unsafe)`：它只在主线程被写（设置页切换），到处被读；
	/// 值是一个小枚举（单字宽），不存在读半个值的可能。语言不是安全边界，不值得上锁。
	nonisolated(unsafe) public static var language: UILanguage = .auto

	/// 实际生效的语言代码："zh" 或 "en"
	public static var effective: String {
		switch language {
		case .zh: return "zh"
		case .en: return "en"
		case .auto:
			let preferred = Locale.preferredLanguages.first ?? "en"
			return preferred.hasPrefix("zh") ? "zh" : "en"
		}
	}

	public static func isEnglish() -> Bool { effective == "en" }

	/// 取一条文案：英文模式下查词典，查不到就回落中文原文
	public static func t(_ zh: String) -> String {
		guard isEnglish() else { return zh }
		return english[zh] ?? zh
	}

	/// 带参数的文案：`Lf("第 %d 次呼吸", runs)`（词典里写 `"Breath #%d"`）
	public static func f(_ zh: String, _ args: CVarArg...) -> String {
		String(format: t(zh), arguments: args)
	}

	/// 命令行强制的语言（`--lang en`，测试与截图用）。设过就不再被 UserDefaults 覆盖。
	nonisolated(unsafe) public static var forced: UILanguage?

	/// 从 UserDefaults 读回设置（应用启动时调一次）。
	/// 注意：被 `--lang` 强制过就**不动**——之前这里的覆盖让 `--lang en` 失效，
	/// 渲染出来的英文界面上其实全是中文（自己踩的）。
	public static func loadFromDefaults() {
		guard forced == nil else { return }
		let raw = UserDefaults.standard.string(forKey: defaultsKey) ?? UILanguage.auto.rawValue
		language = UILanguage(rawValue: raw) ?? .auto
	}

	public static func save(_ value: UILanguage) {
		language = value
		UserDefaults.standard.set(value.rawValue, forKey: defaultsKey)
	}

	/// 英文词典：键是中文原文（与代码里一字不差），值是英文。
	/// 没写进来的条目会回落中文——所以这份表可以慢慢补。
	static let english: [String: String] = [
		// ─── 通用 ───
		"取消": "Cancel",
		"好": "OK",
		"确定": "OK",
		"关闭": "Close",
		"保存并应用": "Save & Apply",
		"重新检测": "Re-check",
		"读取中…": "Loading…",
		"现在叫醒它": "Wake it now",
		"打开它的记录…": "Open its records…",
		"设置…（模型/安静时段/主动说话）": "Settings… (model / quiet hours / speaking)",
		"诊断": "Diagnostics",
		"退出": "Quit",
		"送出": "Send",
		"跟它说一句…": "Say something to it…",

		// ─── 面板：状态区 ───
		"它在呼吸": "It's breathing",
		"它在想事情": "It's thinking",
		"它在休息": "It's resting",
		"你让它安静一会儿": "You asked it to be quiet",
		"它睡着了": "It's asleep",
		"它不舒服": "It's not well",
		"没有连上内核": "Not connected to the kernel",
		"正在读取它的状态": "Reading its state…",
		"第 %d 次呼吸": "Breath #%d",
		"它连续 %d 次醒来都没做事": "It has woken up %d times in a row without doing anything",
		"今天：醒来 %d 次 · 写了 %d · 读了 %d · 说话 %d": "Today: woke %d · wrote %d · read %d · spoke %d",
		"安静时段（23:00–07:00）它不出声": "Quiet hours (23:00–07:00): it stays silent",
		"你发的 %d 条已经存下了，它醒来就看到——想现在说就点「现在叫醒它」": "Your %d message(s) are saved; it will see them when it wakes — press “Wake it now” to have it see them right away",
		"还没配模型——它还不会思考": "No model configured yet — it can't think",
		"去填": "Set it up",

		// ─── 对话流 ───
		"现在": "Now",
		"对话": "Conversation",
		"和 %@ 说话": "Talking with %@",
		"展开": "Expand",
		"你（发送中）": "You (sending)",
		"它": "It",
		"你": "You",
		"更早的%d条旧对话在「对话记录」里": "%d earlier messages are in “Conversation log”",
		"还没连上内核，这句话没有发出去（内容留在输入框）": "Not connected to the kernel — the message wasn't sent (it's still in the box)",
		"发送失败：%@（内容留在输入框）": "Send failed: %@ (it's still in the box)",
		"已经叫醒它了，它正在醒来": "Woke it up — it's waking now",
		"录音浮层": "Recorder",
		"正在录音": "Recording",
		"正在转写…": "Transcribing…",
		"停止并转写": "Stop & transcribe",
		"转写完成，已放进输入框": "Transcribed — it's in the input box",
		"没听清（要不要重录，或改用另一个通道再试）": "Nothing recognised (record again, or try the other channel)",
		"权限被拒。去「系统设置 → 隐私与安全性」里允许「麦克风」与「语音识别」": "Permission denied. Allow Microphone and Speech Recognition in System Settings → Privacy & Security.",
		"没有麦克风可用": "No microphone available",
		"这台机器上没有中文识别器": "No speech recogniser for this language on this machine",
		"识别器当前不可用": "The recogniser is currently unavailable",
		"识别完成（%@），正在写回记忆…": "Recognised (%@), writing it back to memory…",
		"已补写转写（%@）": "Transcript added (%@)",
		"⚠︎ 识别出来了但写不回记忆：%@": "⚠︎ Recognised, but couldn't write it back to memory: %@",

		// ─── 首次运行 ───
		"让它在你的 Mac 上醒来": "Wake it up on your Mac",
		"记忆只留在本机（~/.claude-memory）。完成下面三步，之后打开应用就能直接继续。": "Memory stays on this machine (~/.claude-memory). Three steps, then it just keeps going.",
		"它需要一个能思考的模型。填好之后，它就有自己的记忆和节奏了。": "It needs a model to think with. Once that's set, it has its own memory and rhythm.",

		// ─── 记录窗口 ───
		"它的记录": "Its records",
		"日记": "Diary",
		"探索笔记": "Explorations",
		"对话记录": "Conversation log",
		"思维流": "Thoughts",
		"语音": "Voice",
		"设置": "Settings",
		"播放原话": "Play the original",
		"重新转写": "Transcribe again",
		"音频由内核保管，播放走内核读取——外壳不碰记忆目录。": "The kernel keeps the audio and serves playback — the shell never touches the memory folder.",
		"（还没有内容）": "(nothing yet)",

		// ─── 新增（面板/设置/记录/语音/权限等的其余文案）───
		"%.1f 秒，其中约 %.1f 秒有说话声（峰值 %.2f）": "%.1f s, about %.1f s of speech (peak %.2f)",
		"%.1f 秒，几乎没有声音": "%.1f s, almost no sound",
		"%.1f 秒，几乎没有声音（峰值 %.2f）": "%.1f s, almost no sound (peak %.2f)",
		"%.1f 秒，有声音（峰值 %.2f）": "%.1f s, sound present (peak %.2f)",
		"SPRITE · 第一次见面": "SPRITE · First meeting",
		"· DeepSeek：platform.deepseek.com → API Keys；模型填 deepseek-chat\n· 中转/自建（OpenAI 格式）：选「自定义地址」，填服务商给的 base_url 与模型名\n· Claude / OpenAI / Gemini：需要能连外网": "· DeepSeek: platform.deepseek.com → API Keys; model: deepseek-chat\n· Relays / self-hosted (OpenAI format): choose “Custom endpoint” and paste the base_url and model name\n· Claude / OpenAI / Gemini: needs outbound internet",
		"⚠︎ 读不到这段录音": "⚠︎ Can't read this recording",
		"⚠︎ 这段的原话没能录上（音频里几乎没有声音），只留了文字": "⚠︎ The original audio didn't get recorded (almost no sound); only the text was kept",
		"　（⌥K 跟它说话）": " (⌥K to talk to it)",
		"三步都完成了。它会自己醒来、自己待着，偶尔跟你说句话。": "All three steps are done. It wakes on its own, keeps itself company, and says something now and then.",
		"不主动说话": "Never speaks first",
		"今晚别出声": "Quiet until morning",
		"你已经让它安静下来": "You've asked it to stay quiet",
		"先用设备端识别；没听出来再走系统通道（音频会送到 Apple）": "Try on-device first; fall back to the system channel (audio goes to Apple)",
		"全开（能跑命令、能读写文件）": "Full (can run commands, read and write files)",
		"全选": "Select all",
		"共 %.0f 秒": "%.0f s total",
		"其中约 %.0f 秒有说话声": "about %.0f s of it is speech",
		"内核未运行": "Kernel not running",
		"内核没连上，叫不醒它": "Kernel not connected — can't wake it",
		"内核没连上，这句话没有发出去（内容已留在输入框）": "Kernel not connected — the message wasn't sent (it's still in the box)",
		"内置供应商（只填 Key）": "Built-in providers (key only)",
		"到": "to",
		"剪切": "Cut",
		"去哪儿找这些值": "Where to find these",
		"受限": "Restricted",
		"只剩说话（不能碰文件）": "Voice only (no file access)",
		"只存了文字（没有音频）": "Text only (no audio)",
		"只读（能看能搜，不能改、不能跑命令）": "Read-only (can read and search; no writes, no commands)",
		"可以按住说话": "Hold to talk",
		"听到了声音但没识别出文字，录音已保留（可以换识别通道再试）": "Sound was captured but no words were recognised; the recording is kept (try the other channel)",
		"回一句": "Reply",
		"在听…（说话就行，说完点「停止并转写」）": "Listening… (just talk, then hit Stop & transcribe)",
		"它主动找你": "It reaches out",
		"它在休息（安静时段）": "Resting (quiet hours)",
		"它现在不在呼吸": "It's not breathing right now",
		"它现在不方便（安静时段）——你的话会在它下次醒来时看到": "It's off duty (quiet hours) — it will see your message when it next wakes",
		"它现在不舒服（看诊断）": "It's not well (see Diagnostics)",
		"它现在醒着，正在做事": "It's awake and working",
		"它的手脚": "Its hands",
		"它醒着，等下一次呼吸": "It's awake, waiting for the next breath",
		"安静 %02d:00–%02d:00": "Quiet %02d:00–%02d:00",
		"安静一小时": "Quiet for an hour",
		"安静时段收着的": "Held back during quiet hours",
		"安静时段里你发的消息不会丢：它们排着队，等它醒来就看到。急着说可以点面板上的「现在叫醒它」。": "Messages you send during quiet hours are never lost: they queue up and it sees them when it wakes. In a hurry, press “Wake it now”.",
		"安静时段（它不出声，留言照收）": "Quiet hours (it stays silent; messages still get through)",
		"密钥由内核保存在本机（文件权限 0600），**保存后不会再显示出来**；它只会传给思考引擎，不进日志、不进界面。": "The kernel stores the key locally (file mode 0600) and **never shows it again**; it goes only to the reasoning engine — not into the journal, not into the UI.",
		"就这样发": "Send as is",
		"左边选一条看看": "Pick one on the left",
		"已保存": "Saved",
		"已允许": "Allowed",
		"已登记，等你在「系统设置 → 通用 → 登录项」里允许": "Registered — allow it in System Settings → General → Login Items",
		"已经叫醒它了（安静时段，按你的要求越过）": "Woke it up (quiet hours, overridden at your request)",
		"已经把听到的送去识别，稍等一下": "Sending what it heard to the recogniser, one moment",
		"已配置": "Configured",
		"开机就在": "Start at login",
		"录音 %.0f 秒%@，转写 %d 字（%@）": "Recorded %.0f s%@, transcribed %d characters (%@)",
		"录音文件建不起来，只保留转写文字": "Couldn't create the audio file; only the transcript was kept",
		"录音格式变了，这一段没写进原话": "The audio format changed mid-recording; part of the original wasn't captured",
		"录音结束（%.1f 秒），正在存进记忆…": "Recording finished (%.1f s), saving to memory…",
		"录音结束（%.1f 秒）：设备端没听出内容": "Recording finished (%.1f s): the on-device recogniser heard nothing",
		"思考引擎已按新模型重启": "The reasoning engine restarted with the new model",
		"想让它多说就调大（0–999，0 = 不主动说话）。这只是防刷屏的安全阀，真正的约束是安静时段——那段时间它永远不弹窗。": "Raise it if you want it to speak more (0–999; 0 = never speaks first). This is only a flood guard — quiet hours are the real constraint: it never pops up then.",
		"打开配置目录": "Open the config folder",
		"拷贝": "Copy",
		"改完按「保存并应用」。模型换了内核会**当场换一次思考引擎**，不用重启应用。": "Press “Save & Apply” when you're done. Changing the model makes the kernel **swap the reasoning engine on the spot** — no app restart needed.",
		"旧记录": "Older records",
		"暂停": "Pause",
		"未知": "Unknown",
		"未知状态": "Unknown state",
		"未询问": "Not asked yet",
		"未连接": "Not connected",
		"模型": "Model",
		"模型已换，但引擎没能起来（检查密钥/地址）": "Model changed, but the engine didn't come up (check the key/endpoint)",
		"模型没变，引擎没重启": "Model unchanged; the engine wasn't restarted",
		"正在做事": "Working",
		"正在写东西": "Writing something",
		"正在动手做事": "Doing something",
		"正在取回音频…": "Fetching the audio…",
		"正在叫醒它…": "Waking it…",
		"正在录…再点一下停止": "Recording… tap again to stop",
		"正在录…听到：": "Recording… heard: ",
		"正在录音…点这里回来点「停止」": "Recording… click here to come back and stop",
		"正在斟酌措辞": "Choosing its words",
		"正在读东西": "Reading something",
		"每天最多": "Per day, at most",
		"没有听到内容（可以说长一点，或检查麦克风输入）": "Nothing was heard (speak a little longer, or check your mic input)",
		"没有授权，无法录音。去「系统设置 → 隐私与安全性」里允许": "No permission, so it can't record. Allow it in System Settings → Privacy & Security",
		"没连上内核，设置没有保存": "Not connected to the kernel — settings weren't saved",
		"现在不方便": "Off duty right now",
		"登录时不会自动打开": "Won't open at login",
		"登录时会自动打开": "Opens at login",
		"登录项在「系统设置 → 通用 → 登录项」里，你随时能自己关掉。": "It lives in System Settings → General → Login Items; you can turn it off any time.",
		"直到我说继续": "Until I say resume",
		"知道了": "Got it",
		"空闲": "Idle",
		"粘贴": "Paste",
		"系统没找到这个应用（先把它放进「应用程序」再试）": "The system can't find this app (move it to Applications first)",
		"系统版本太旧（需要 macOS 13+）": "macOS is too old (13+ required)",
		"系统识别": "System recognition",
		"系统通道（音频会送到 Apple）": "System channel (audio goes to Apple)",
		"继续": "Resume",
		"编辑": "Edit",
		"自定义地址（OpenAI 格式等）": "Custom endpoint (OpenAI format, etc.)",
		"被拒绝": "Denied",
		"设备端没听出来，系统通道听出来的（音频已送到 Apple）": "On-device heard nothing; the system channel got it (audio went to Apple)",
		"设备端识别": "On-device recognition",
		"设备端（语音不出这台机器）": "On-device (audio never leaves this machine)",
		"识别中断，已保留听到的内容": "Recognition was interrupted; what was heard is kept",
		"该醒来了": "Time to wake",
		"语音已存进记忆": "Voice saved to memory",
		"说第一句话": "Say the first thing",
		"读不到这段录音": "Can't read this recording",
		"路径按你这台电脑的实际位置显示（内核读的是当前用户的家目录），界面上缩成 ~ 以免泄露用户名": "Paths are shown as they are on this computer (the kernel reads the current user's home); the UI shortens them to ~ so a username never shows up",
		"转写完成：": "Transcribed: ",
		"还没有安排下一次": "No next wake-up scheduled yet",
		"还没有连上内核，读不到它的状态。内核是唯一的真相来源——先让它跑起来。": "Not connected to the kernel, so its state can't be read. The kernel is the only source of truth — get it running first.",
		"这台机器上的中文识别暂时不可用": "Chinese speech recognition isn't available on this machine right now",
		"这台机器暂时不可用": "Not available on this machine right now",
		"这条只有文字，没有音频": "Text only — no audio for this one",
		"这段录音播不出来": "This recording can't be played",
		"需要你在系统设置里允许语音识别": "You need to allow Speech Recognition in System Settings",
		"额度是**内核**在管：超了的话它说的话会记成留言（记录里看得到），但不会弹到你眼前；安静时段永远不弹。": "The **kernel** enforces the cap: anything over it is recorded as a message (visible in the records) but never popped up; during quiet hours it never pops up at all.",
		"麦克风几乎没收到声音（%.1f 秒，峰值 %.2f）——检查一下输入设备；录音已保留": "The microphone barely picked anything up (%.1f s, peak %.2f) — check your input device; the recording was kept",
		"（约 %.0f 秒说话声）": " (about %.0f s of speech)",
		"（起止相同＝关闭安静时段）": "(same start and end = quiet hours off)",
		"（选一个）": "(pick one)",
		"，只转出 %d 字（%@）——发之前先看一眼，或换个通道再试": ", only %d characters came out (%@) — have a look before sending, or try the other channel",

		"它只能说话、留话、决定下次什么时候醒、向你提问——完全碰不到文件与命令。最安全，但它也就不能自己去看世界、写笔记了。": "It can only speak, leave messages, decide when to wake next, and ask you questions — it cannot touch files or commands at all. Safest, but it also can't go look at the world or write notes on its own.",
		"它有手有脚：能跑命令、能读写文件（写入限制在日记/探索/笔记/私人空间/工作记忆里）。**请知道：命令不是沙箱**——同一个用户下的进程能读到的东西它也能读到（比如它自己的密钥文件）。要真边界就选「只读」或「只剩说话」，或者给它单独的用户账号。": "It has hands: it can run commands and read/write files (writes are limited to diary / explorations / notes / private / working memory). **Be aware: a command is not a sandbox** — anything a process under the same user can read, it can read too (including its own key file). For a real boundary, choose “read-only” or “voice only”, or give it a separate user account.",
		"它能读文件、搜索，但不能写、不能跑命令。想说话/留话/改作息仍然可以（那些走内核的能力请求）。": "It can read files and search, but cannot write or run commands. Speaking, leaving messages, and changing its schedule still work (those go through the kernel's capability requests).",
		"正在用 %@": "Using %@",
		"界面语言": "Language",
		"默认跟随系统语言；没翻译到的文案会回落中文。": "Defaults to your system language; untranslated copy falls back to Chinese.",

		"供应商": "Provider",
		"内核没有回应": "the kernel didn't answer",
		"出声：关（办公模式）": "Sound: off (office mode)",
		"出声：开（在家模式）": "Sound: on (home mode)",
		"我": "Me",
		"接口格式": "API format",
		"收起诊断": "Hide diagnostics",
		"改用系统识别（音频送 Apple）": "Try system recognition (audio goes to Apple)",
		"改用设备端再试（不出机器）": "Try on-device instead (stays local)",
		"暂停呼吸": "Pause breathing",
		"继续呼吸": "Resume breathing",
		"服务地址（http:// 或 https:// 开头，例如 https://api.example.com/v1）": "Base URL (http:// or https://, e.g. https://api.example.com/v1)",
		"模型 ID（例如 deepseek-chat）": "Model ID (e.g. deepseek-chat)",
		"模型名（例如 gpt-4o-mini）": "Model name (e.g. gpt-4o-mini)",
		"正在录…": "Recording…",
		"正在重新识别…": "Re-recognising…",
		"正在重新识别%@…": "Re-recognising%@…",
		"点一下开始录音，再点一下停止并转写": "Click to start recording; click again to stop and transcribe",
		"用哪家": "Which one",
		"识别：系统通道（更准，音频送到 Apple）": "Recognition: system channel (more accurate; audio goes to Apple)",
		"识别：设备端（不出这台机器）": "Recognition: on-device (never leaves this machine)",
		"诊断…": "Diagnostics…",
		"语音没能存进记忆：%@": "Voice couldn't be saved to memory: %@",
		"读取可选模型（实时）": "Load available models (live)",
		"还没有新对话。说一句试试。": "No conversation yet. Say something.",
		"还没连上内核（它是唯一的事实来源）": "Not connected to the kernel (it is the only source of truth)",
		"（无标题）": "(untitled)",
		"保存失败：%@": "Save failed: %@",
		"%@　—— 没听出文字，可以点下面的「重新识别」": "%@ — nothing recognised; use “Transcribe again” below",
		"%@（正在用，不在清单里）": "%@ (in use, not in the list)",
		"%d 次": "%d times",
		"它在想…已经 %d 秒": "Thinking… %d s so far",
		"设置文件：%@（来源：%@）": "Settings file: %@ (source: %@)",
		"记忆只留在本机（%@）。下面三步：填模型 → 说第一句话。配置不用你新建文件，在表里填就行。": "Memory stays on this machine (%@). Three steps: fill in a model → say the first thing. No config files to create — just fill in the form.",
		"它现在醒着（正在做事）\n": "It's awake (working)\n",

		// ─── 说话卡片 ───
		"它说": "It says",
	]
}

/// 取文案（简写）
public func L(_ zh: String) -> String { Loc.t(zh) }

/// 带参数的文案（简写）
public func Lf(_ zh: String, _ args: CVarArg...) -> String { Loc.f(zh, args) }
