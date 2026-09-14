/**
 * 投影器：把新事件写成人类可读的产物。
 *
 * 只处理"新内容"三类事件（它说的话、用户说的话、它的思维），其余事件不落文件。
 * 重要：**导入进来的历史事件不能再投影一遍**——它们本来就是从这些文件里读出来的。
 * 调用方通过水位线（import watermark）保证这一点，见 main.ts。
 *
 * 投影失败不能让内核倒下：返回错误字符串，由调用方记 system.problem。
 */

import type { JournalEvent } from "../contracts/events.ts";
import { appendMailboxLine, appendThoughtLine, MAILBOX_RELATIVE, THOUGHTS_RELATIVE } from "./projections.ts";

export type ProjectionResult = { ok: true; file: string } | { ok: false; error: string };

export type ProjectorDeps = {
	homeDir: string;
	companionName: string;
	/** v1 里用户的称呼是「用户」；保持它，旧阅读器与导出脚本才认。 */
	userSpeaker?: string;
	fsync?: boolean;
	log?: (message: string) => void;
};

export type Projector = {
	/** 返回写入的产物文件（相对记忆之家），失败时返回错误交给调用方上报。 */
	project(event: JournalEvent): ProjectionResult;
	supported(type: string): boolean;
};

const SUPPORTED = new Set(["message.in", "message.out", "thought.recorded"]);

export function createProjector(deps: ProjectorDeps): Projector {
	const { homeDir, companionName, userSpeaker = "用户", fsync = true, log = () => {} } = deps;

	function project(event: JournalEvent): ProjectionResult {
		try {
			switch (event.type) {
				case "message.in":
					appendMailboxLine(
						homeDir,
						{ speaker: userSpeaker, text: String(event.data.text ?? ""), at: new Date(event.at) },
						{ fsync },
					);
					return { ok: true, file: MAILBOX_RELATIVE };
				case "message.out":
					appendMailboxLine(
						homeDir,
						{ speaker: companionName, text: String(event.data.text ?? ""), at: new Date(event.at) },
						{ fsync },
					);
					return { ok: true, file: MAILBOX_RELATIVE };
				case "thought.recorded":
					appendThoughtLine(
						homeDir,
						{
							text: String(event.data.text ?? ""),
							kind: typeof event.data.legacyType === "string" ? event.data.legacyType : "breath",
							at: new Date(event.at),
						},
						{ fsync },
					);
					return { ok: true, file: THOUGHTS_RELATIVE };
				default:
					return { ok: true, file: "" };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`[projector] 投影失败 (${event.type} #${event.seq}): ${message}`);
			return { ok: false, error: message };
		}
	}

	return {
		project,
		supported: (type) => SUPPORTED.has(type),
	};
}
