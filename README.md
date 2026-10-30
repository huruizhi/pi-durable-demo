# Pi Durable + 本地模型 Demo

GitHub：<https://github.com/huruizhi/pi-durable-demo>

这个 Demo 按 PDF 的核心结构实现：本地 OpenAI-compatible 模型服务负责加载模型，Pi Durable 负责 Agent loop、工具调用、SQLite 持久化和跨进程恢复。所有运行逻辑收敛在一个 `src/demo.mjs` 文件中，并提供一次性 CLI、交互式 TUI 和自动恢复实验三种入口。

> PDF 配套笔记中的本地服务示例是 `llama.cpp`（`127.0.0.1:8080/v1`）。本项目默认使用 vLLM（`127.0.0.1:8000/v1`），因为两者都提供 OpenAI-compatible API；切换服务只需要改环境变量。

## 1. 启动 vLLM

### Apple Silicon macOS

当前项目运行环境是 Apple Silicon macOS。普通 NVIDIA/CUDA 版 vLLM 不是合适的安装路径，应安装 vLLM-Metal：

```bash
brew tap vllm-project/vllm-metal https://github.com/vllm-project/vllm-metal
brew install vllm-project/vllm-metal/vllm-metal
```

然后启动一个 MLX 格式的 Qwen 模型：

```bash
vllm serve /Volumes/rzhu-SSD/models/mlx-community/Qwen2.5-3B-Instruct-4bit \
  --served-model-name mlx-community/Qwen2.5-3B-Instruct-4bit \
  --host 127.0.0.1 \
  --port 8000 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --chat-template /Users/rzhu/Documents/Workplace/dev/pi-durable-demo/data/qwen25-chat-template.jinja
```

`--enable-auto-tool-choice` 和 `--tool-call-parser hermes` 是工具调用所需的 vLLM 参数；项目附带的 chat template 修正了 Qwen2.5 默认模板中的工具调用示例格式。模型文件位于 `/Volumes/rzhu-SSD/models/mlx-community/Qwen2.5-3B-Instruct-4bit`，约 1.6 GB。

如果该模型仓库在当前 vLLM-Metal 版本中不可用，可以先用官方已验证的 Qwen 小模型确认服务链路：

```bash
vllm serve Qwen/Qwen3-0.6B \
  --host 127.0.0.1 \
  --port 8000 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

### NVIDIA GPU/Linux

在 NVIDIA GPU 环境中，启动一个 Qwen 3B 模型：

```bash
vllm serve Qwen/Qwen2.5-3B-Instruct \
  --host 127.0.0.1 \
  --port 8000
```

如果 vLLM 使用的模型 ID 与命令不同，通过环境变量指定：

```bash
LOCAL_MODEL_NAME=mlx-community/Qwen2.5-3B-Instruct-4bit \
LOCAL_MODEL_BASE_URL=http://127.0.0.1:8000/v1 \
npm run demo -- --task
```

严格复现 PDF 中的 llama.cpp 地址时：

```bash
llama-server \
  -m /path/to/Qwen3.5-0.8B-BF16.gguf \
  --host 127.0.0.1 \
  --port 8080
```

然后：

```bash
LLAMA_BASE_URL=http://127.0.0.1:8080/v1 \
LLAMA_MODEL=Qwen3.5-0.8B \
npm run demo -- --task
```

## 2. 提交一个任务

```bash
cd /Users/rzhu/Documents/Workplace/dev/pi-durable-demo
npm install
npm run check
npm run demo -- --fresh --task
```

`--task` 会要求 Agent 读取 `data/demo-task.txt`，触发 `read` 工具，再解释 Pi Durable 的作用。也可以提交普通问题：

```bash
npm run demo -- "请解释 Pi Durable 为什么适合长任务"
```

## 3. 进入交互式 TUI

```bash
npm run tui
```

TUI 会复用同一个 `data/demo.sqlite` 会话。普通输入会提交给 Agent；Agent 可以使用 Pi Durable 的四个 coding tools：`read`、`write`、`edit`、`bash`。工具调用和工具结果会在终端中显示。

内置命令：

- `/inspect`：查看当前调度器、活动任务和未完成 submission。
- `/resume`：重新启用 Harness 调度器。
- `/fresh`：清空 SQLite 会话并重新开始。
- `/quit`：退出 TUI。

可用参数：

- `--fresh`：删除本地 SQLite 会话后再提交。
- `--task`：读取演示文件并回答。
- `--help`：显示帮助。

## 4. 演示中断恢复

先提交一个任务：

```bash
npm run demo -- --task
```

如果在模型生成或工具调用期间终止宿主进程，再运行：

```bash
npm run resume
```

恢复程序会重新打开同一个 SQLite，调用 `inspect()` 找到未完成的 submission，调用 `resume()` 重新启动任务调度器，再等待原 submission 的最终结果。它不是重新创建一条聊天，也不是从内存现场恢复 CPU，而是从持久化检查点继续任务。

## 5. 自动完成中断恢复实验

```bash
npm run experiment
```

实验会使用独立的 `data/recovery-experiment.sqlite`：

1. 启动一个子进程提交 Durable 任务；
2. 模型调用 `durable_pause` 后，父进程强制终止子进程；
3. 查询中断后的 `tasks`、`submissions` 和 `entries`；
4. 启动新的 Harness 进程；
5. 调用 `resume()`，等待原 submission 完成；
6. 再次输出恢复后的 SQLite 快照。

这条命令不会清理或覆盖默认的 `data/demo.sqlite`。

实验已经实际验证通过：

```text
中断前：
  pi.generation = waiting
  pi.tool       = running
  submission    = placed

恢复后：
  pi.generation = terminal/completed
  pi.tool       = terminal/completed
  submission    = done
  answer        = pause completed
```

实验数据库会保留在 `data/recovery-experiment.sqlite`，便于使用 SQLite 命令继续检查。

## 6. 代码结构

- `src/demo.mjs`：唯一运行文件，包含 CLI、TUI、恢复入口、实验 worker、SQLite 快照和 Harness 初始化。
- `data/demo-task.txt`：触发 `read` 工具的演示文件。
- `data/qwen25-chat-template.jinja`：vLLM 的 Qwen2.5 工具调用模板。
- `docs/pi-durable-blog-evidence.md`：Blog 所需的架构说明、SQLite 快照和恢复实验记录。

## 7. 这个 Demo 说明什么

1. 本地模型服务与 Pi Durable 解耦，模型只负责生成和工具选择。
2. 用户输入会成为持久化 Submission。
3. `createCodingTools()` 加载 `read`、`write`、`edit`、`bash`，每次工具调用和检查点写入 SQLite。
4. 宿主进程退出后，可以重新打开 Harness 并继续未完成任务。
5. Pi Durable 不会让外部副作用自动 exactly-once；真实的邮件、支付或 Issue 操作仍需要幂等键、去重和审计。

Pi Durable 官方文档：
<https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>

vLLM OpenAI-compatible 服务文档：
<https://docs.vllm.ai/en/stable/getting_started/quickstart/>

Blog 证据准备：
[docs/pi-durable-blog-evidence.md](docs/pi-durable-blog-evidence.md)
