# 参与这个项目

先说清楚这个项目是什么：**一个内核 + 一个原生外壳**。

- `core/` —— 内核。记忆、人格、呼吸调度、pi 运行时。**它是唯一的写入者**：所有事实都进
  append-only 的 JSONL 日志，markdown（日记、对话记录）只是它的投影。
- `shell/` —— macOS 菜单栏应用（SwiftUI）。它**不读记忆文件**，只通过本机 Unix socket 上的
  JSON-RPC 跟内核说话，契约在 `contracts/`。
- `pi-extension/` —— pi 的扩展：它"手和脚"的策略层（能读写哪些路径、能跑什么命令）。

改动前请先接受两条不变量，它们比性能重要：

1. **单一写入者**：任何写记忆的路径都必须经过内核。外壳、脚本、扩展都不许直接写日志或投影。
2. **身份不属于仓库**：这个仓库不预置人格、不带任何真实实例的名字或对话。
   **提交里不许出现任何具体个体的身份材料、真实记忆内容、密钥或绝对家目录路径。**

## 开发

```bash
node --test "core/**/*.test.ts"   # 内核测试（无需构建步骤，Node 原生 TypeScript）
cd shell && swift test            # 外壳契约测试
Scripts/verify-all.sh             # 十个阶段：类型检查 / 内核 / 契约 / 并发告警 / 自检 /
                                  # 活体链路 / 语音（真麦克风）/ 断线重连 / soak / 规模
```

改动请配套测试：**先能复现，再修**。这个仓库里几乎所有真问题都是被测试（而不是被推理）抓住的——
包括那些"只在满载下偶发"的竞态。回归测试集中在 `core/review-regressions.test.ts`。

## 提交前自查（会被 CI 与本地守卫检查）

- 密钥、真实记忆、具体个体的名字：`python3 Scripts/privacy-scan.py . HEAD`（它拿**本机的真实记忆**
  当探针；在没有记忆的机器上只跑模式检查）。
- 绝对家目录：`core/settings.test.ts` 里的守卫测试会扫**全部被 git 跟踪的文件**。
- 构建产物不进仓库：`shell/.build*`、`.core-test/`、`.demo/` 都在 `.gitignore` 里。

## 发布

发布走 `Scripts/publish-code.sh --push`：它只把**代码**打成快照推到 `origin/main`，
开发线（含文档与试制品）留在本地。仓库里的 `.git/hooks/pre-push`（源文件 `Scripts/hooks/pre-push`）
会对每一次推送跑隐私闸门——**包含私人内容的推送会被直接拦下**。

## 许可

见 [LICENSE](LICENSE)。
