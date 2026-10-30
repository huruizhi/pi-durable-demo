# Pi Durable 状态恢复 Blog：信息与数据准备稿

> 用途：为一篇分析“Pi Durable 为什么可以恢复 Agent 执行状态”的技术 Blog 准备事实、源码线索、SQLite 实际数据和待补实验。
>
> 证据快照：2026-10-30 22:35，Asia/Shanghai。数据库和模型服务是会继续变化的运行状态；发布文章前应重新执行本文的查询并更新快照。

## 1. Blog 的核心结论

文章要证明的不是“Pi Durable 使用了 SQLite”，而是：

> Pi Durable 将 Agent 的一次执行拆成可持久化的 submission、generation task、tool task、entry 和 document 状态；每个可恢复边界先提交状态，再由 Harness 调度下一步。因此进程退出后可以从数据库中的任务状态和检查点重新调度，而不依赖原进程的内存、调用栈或局部变量。

这句话需要同时由三类证据支撑：

1. 官方设计和源码说明；
2. SQLite 中实际保存的记录；
3. 一次真实的中断、重启和恢复实验。

三类证据已经具备：官方设计和源码、SQLite 实际记录，以及一次独立数据库上的真实中断恢复实验。

## 2. 当前 Demo 环境快照

### 项目

    项目目录：/Users/rzhu/Documents/Workplace/dev/pi-durable-demo
    数据库：  /Users/rzhu/Documents/Workplace/dev/pi-durable-demo/data/demo.sqlite
    入口：    npm run demo
    TUI：     npm run tui
    恢复：    npm run resume
    检查：    npm run check

### 包版本

    Node.js：v22.23.1
    npm：10.9.8
    @earendil-works/pi-durable：1.4.0
    @earendil-works/pi-ai：1.4.0
    @earendil-works/chord：1.4.0
    vLLM-Metal：0.32.0+cpu

### 模型服务

    模型：mlx-community/Qwen2.5-3B-Instruct-4bit
    模型文件：/Volumes/rzhu-SSD/models/mlx-community/Qwen2.5-3B-Instruct-4bit
    模型大小：约 1.6G
    API：http://127.0.0.1:8000/v1
    健康检查：HTTP 200

模型服务只是 Pi Durable 的外部模型提供者；模型加载、Metal、vLLM KV cache 不属于“状态恢复机制”的核心论证，建议放到 Blog 的环境说明或附录。

## 3. 当前源码中的关键事实

### 3.1 本地模型通过 OpenAI-compatible API 接入

位置：src/demo.mjs。

关键配置：

    const model = {
      api: "openai-completions",
      provider: "local",
      baseUrl: LOCAL_MODEL_BASE_URL,
    };

因此可以把“模型生成”和“任务持久化”分开解释：

    vLLM / llama.cpp：负责模型推理和工具选择
    Pi AI：           负责统一模型 API
    Pi Durable：      负责提交、任务、工具和恢复
    SQLite：          负责保存持久化状态

### 3.2 工具通过 createCodingTools() 加载

位置：src/demo.mjs 的 createDurableHarness()。

当前加载的工具：

    read
    write
    edit
    bash

它们通过 NodeExecutionEnv 执行，而不是直接绕过 Durable 调用 Node.js 文件或进程 API：

    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? PROJECT_ROOT })

这意味着工具调用可以进入独立的 pi.tool task，并保存工具参数、工具结果和任务状态。

### 3.3 Agent 通过 Harness 提交任务

位置：src/demo.mjs。

核心调用链：

    const submission = await root.submit({
      type: "input",
      content: prompt,
      requestId,
    }, CONTEXT);

    const settled = await submission.wait(CONTEXT);

TUI 中还会在提交前后读取 conversation entries，用于显示：

    submission
    tool call
    tool result
    final answer

### 3.4 恢复入口

位置：src/demo.mjs 的 runResume()。

当前恢复流程：

    checkModelServer()
      ↓
    Harness.open(same SQLite)
      ↓
    harness.inspect()
      ↓
    筛选 queued / placed submission
      ↓
    harness.resume()
      ↓
    重新取得 submission
      ↓
    submission.wait()

需要在 Blog 中明确：resume() 不是恢复原来的 Node.js 调用栈，而是重新启用 Durable scheduler，让未完成的持久化 task 根据数据库状态继续执行。

## 4. SQLite 数据模型

当前 SQLite 表：

    conversations
    durable_metadata
    record_ids
    document_revisions
    documents
    submissions
    entries
    tasks
    durable_schema

### 4.1 tasks：恢复执行状态的核心表

当前表字段：

    id
    conversation_id
    kind
    status
    abort_requested
    background
    record

record JSON 中保存：

    {
      "id": 12,
      "kind": "pi.tool",
      "input": {
        "kind": "model",
        "assistant": 11,
        "callId": "..."
      },
      "owner": 9,
      "state": {
        "status": "terminal",
        "outcome": {
          "status": "completed",
          "result": {
            "kind": "model",
            "entryId": 13
          }
        }
      }
    }

需要重点解释的字段：

| 字段 | 含义 |
|---|---|
| kind | pi.generation 或 pi.tool 等 Durable task 类型 |
| input | 任务启动时确定的输入 |
| owner | 父任务或所属任务 |
| state.status | 当前 phase 状态 |
| state.outcome | 已完成、失败或中止的结果 |
| result.entryId | 任务结果写入的对话 entry |

### 4.2 submissions：用户任务生命周期

submissions 保存用户提交及最终状态：

    id
    conversation_id
    request_id
    status
    record

一个已完成 submission 的逻辑结构：

    {
      "type": "input",
      "requestId": "cli-...",
      "status": "done",
      "entry": 7,
      "answer": 15
    }

它解决的是“这个用户输入是否已经被接收、执行和回答”，而不是保存全部 task phase。

### 4.3 entries：对话和工具上下文

典型 entry 顺序：

    pi.user
      ↓
    pi.system
      ↓
    pi.assistant   （toolCall）
      ↓
    pi.tool-result
      ↓
    pi.assistant   （最终文本）

entries 是模型下一轮请求需要的上下文，也保存了工具调用和工具结果；但它本身不是调度器的主要状态机。

### 4.4 documents 和 document_revisions

当前会话包含：

    pi.live
    pi.inbox
    pi.usage
    pi.provider
    pi.agent

当前运行快照：

    pi.live  = {}
    pi.inbox = {"items": []}

这说明当前没有正在运行或排队的工作。

pi.agent 当前保存了：

    {
      "model": {
        "provider": "local",
        "modelId": "mlx-community/Qwen2.5-3B-Instruct-4bit"
      },
      "extensions": ["coding-tools"],
      "cwd": "/Users/rzhu/Documents/Workplace/dev/pi-durable-demo"
    }

## 5. 当前数据库真实快照

采集时间：2026-10-30 22:35 Asia/Shanghai。

    conversations：1
    entries：       9
    submissions：   2
    tasks：         6
    documents：     5
    document_revisions：5

任务类型：

    pi.generation：4 个，全部 terminal
    pi.tool：      2 个，全部 terminal

工具结果：

    read：2 次
    错误：0 次

当前 submissions：

    cli-d6b7002e-b9f9-44a8-9a3c-f18539db92a6：done，input entry=7，answer entry=15
    cli-24ae8ea5-2a27-482f-ab76-1ef412d3273d：done，input entry=16，answer entry=23

当前累计用量：

    input tokens：  4,708
    output tokens： 639
    total tokens：  5,347
    cost：          0

## 6. 已有的运行证据

当前 Demo 已经验证：

- vLLM 提供 OpenAI-compatible API；
- Pi AI 能调用本地模型；
- read 工具被模型选中；
- 工具结果进入 pi.tool-result entry；
- pi.tool task 和 pi.generation task 写入 SQLite；
- 最终回答对应一个完成的 submission；
- 工具失败也可以被记录并继续生成回答。

## 7. 仍需补齐的关键证据

### 7.1 真实中断恢复实验：已完成

实验命令：

    npm run experiment

实验使用独立数据库：

    /Users/rzhu/Documents/Workplace/dev/pi-durable-demo/data/recovery-experiment.sqlite

实验步骤和结果：

    1. 子进程创建同一个 Durable Harness 并提交 recovery-experiment-001。
    2. 模型调用 durable_pause，参数 milliseconds=20000。
    3. 父进程立即发送 SIGKILL，子进程退出 code=null、signal=SIGKILL。
    4. 中断快照显示 generation task=waiting、tool task=running、submission=placed。
    5. 新的 Harness 进程打开同一个 SQLite，输出 RESUME_PENDING:1。
    6. durable_pause 在恢复进程中重新完成。
    7. submission 变成 done，最终 answer entry=15。

中断快照：

    tasks：
      pi.generation：status=waiting
      pi.tool：      status=running
    submission：
      status=placed
      request_id=recovery-experiment-001
    entries：
      pi.user
      pi.system
      pi.assistant(stopReason=toolUse)

恢复后快照：

    tasks：
      pi.generation：2 个，全部 terminal/completed
      pi.tool：      1 个，terminal/completed
    submission：
      status=done
      request_id=recovery-experiment-001
      answer entry=15
    entries：
      pi.user
      pi.system
      pi.assistant(stopReason=toolUse)
      pi.tool-result(toolName=durable_pause)
      pi.assistant(stopReason=stop)

这组证据可以支持 Blog 的核心结论：恢复的不是被杀进程的内存或调用栈，而是 SQLite 中仍处于 waiting/running/placed 状态的 Durable task 和 submission；新的 Harness 进程重新加载这些记录后继续调度，最终完成同一个 request_id。

如需重新采集原始 JSON，直接执行：

    npm run experiment

该命令会自动完成子进程启动、SIGKILL、中断快照、Harness 重启、resume 和恢复后快照。

需要保存的 SQL 快照：

    select id, conversation_id, kind, status, abort_requested, background, record
    from tasks
    order by id;

    select id, conversation_id, request_id, status, record
    from submissions
    order by id;

    select id, conversation_id, record
    from entries
    order by id;

### 7.2 requestId 幂等性

需要使用相同 requestId 重复提交，证明恢复或重试时不会创建重复 submission：

    await root.submit({
      type: "input",
      content: "同一个任务",
      requestId: "blog-idempotency-001",
    }, CONTEXT);

然后重新打开 Harness，再次提交相同 requestId，比较两个 submission 的 ID。

### 7.3 等待和睡眠检查点

当前 data/demo-task.txt 描述了“第二步等待”，但 Demo 还没有一个明确的 sleepUntil phase。

Blog 若要解释 sleeping 状态，需要增加一个专门的 Durable task 或测试分支，记录：

    sleep 前的 task state
    sleepUntil 提交后的 task state
    进程退出
    Harness.resume()
    到期后的下一 phase

### 7.4 外部副作用边界

需要补一个说明或测试：

    read 文件       → 通常可安全重试
    bash 命令       → 可能重复执行
    发送邮件        → 需要幂等键
    支付请求        → 需要业务去重
    创建 Issue      → 需要外部 requestId

文章必须避免把“可恢复 task”写成“所有外部操作 exactly-once”。

## 8. 推荐的 Blog 结构

### 标题

《Pi Durable 为什么能恢复 Agent 状态：从 SQLite、Task Checkpoint 到 Resume》

### 正文结构

1. 普通 Agent 在进程中断时会丢失什么；
2. Pi Durable 的 Conversation、Submission、Task、Entry 模型；
3. 一次模型工具调用在 SQLite 中如何展开；
4. tasks、submissions、entries、documents 的职责；
5. Harness 如何重新打开数据库并恢复 scheduler；
6. 工具参数、工具结果和 task checkpoint 如何衔接；
7. requestId 幂等性；
8. 中断恢复实验证据；
9. 工具重试和外部副作用的边界；
10. 与普通内存 Agent loop 的对比。

## 9. 官方资料

- [Pi Durable README v1.4.0](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md)
- [Pi Durable specification](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/docs/spec.md)
- [Pi Durable tools source](https://github.com/earendil-works/pi/tree/v1.4.0/packages/durable/src/tools)
- [vLLM-Metal installation](https://docs.vllm.ai/projects/vllm-metal/en/latest/installation/)

## 10. 发布前检查清单

- [ ] 更新包版本、模型版本和采集时间；
- [ ] 重新采集 SQLite 表数量和关键记录；
- [x] 完成一次真实 kill/restart/resume 实验；
- [x] 保存中断前后的 tasks、submissions、entries 快照；
- [ ] 验证相同 requestId 不会创建重复 submission；
- [ ] 验证工具失败分支；
- [ ] 解释 sleeping / waiting / terminal 的含义；
- [ ] 说明恢复的是 Durable 状态，不是 Node.js 内存和调用栈；
- [ ] 说明外部副作用需要幂等设计；
- [x] 不把当前“全部 terminal”快照误写成“已经完成中断恢复验证”。
