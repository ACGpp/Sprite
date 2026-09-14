// swift-tools-version: 6.0
import PackageDescription

let package = Package(
	name: "Sprite",
	platforms: [.macOS(.v14)],
	targets: [
		// 契约镜像与本地 RPC 客户端：外壳唯一被允许接触内核的方式
		.target(name: "SpriteRPC"),
		// 契约探针：命令行验证 Swift 侧解码与 Node 内核一致
		.executableTarget(name: "sprite-rpc-probe", dependencies: ["SpriteRPC"]),
		// 真正的应用：菜单栏 + 悬浮存在体
		.executableTarget(name: "sprite-shell", dependencies: ["SpriteRPC"]),
		.testTarget(name: "SpriteRPCTests", dependencies: ["SpriteRPC"]),
	],
	// **Swift 6 语言模式**：并发检查从"警告"变成"错误"。
	// 迁移过程：`-strict-concurrency=complete` 从 886 条告警清到 0，再切到这里（见 docs/status.md §九）。
	// 守门：`Scripts/verify-all.sh` 有一阶段用 complete 模式编译并断言零告警。
	swiftLanguageModes: [.v6]
)
