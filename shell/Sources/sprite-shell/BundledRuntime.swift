import AppKit
import Foundation

/// Downloaded builds carry the runtime; source/dev builds keep their existing service.
@MainActor
enum BundledRuntime {
    static func prepareIfPresent(socketPath: String) {
        guard socketPath == defaultSocketPath(),
              let resources = Bundle.main.resourceURL,
              FileManager.default.fileExists(atPath: resources.appendingPathComponent("runtime-manifest.json").path)
        else { return }
        let node = resources.appendingPathComponent("runtime/bin/node")
        let script = resources.appendingPathComponent("bootstrap-runtime.mjs")
        Task {
            let problem = await Task.detached(priority: .userInitiated) { () -> String? in
                let process = Process()
                process.executableURL = node
                process.arguments = [script.path]
                let errors = Pipe()
                process.standardError = errors
                process.standardOutput = FileHandle.nullDevice
                do {
                    try process.run()
                    let data = errors.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    guard process.terminationStatus != 0 else { return nil }
                    return String(data: data, encoding: .utf8) ?? "Runtime setup failed."
                } catch { return error.localizedDescription }
            }.value
            if let problem {
                let alert = NSAlert()
                alert.messageText = L("Sprite 启动失败")
                alert.informativeText = L("请重新打开应用重试。你的记忆没有被删除。") + "\n\n" + problem
                alert.alertStyle = .warning
                alert.addButton(withTitle: L("好"))
                alert.runModal()
            }
        }
    }
}
