import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createProvider, createModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const PROJECT_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const DATABASE_PATH = process.env.PI_DURABLE_DATABASE ?? resolve(DATA_DIR, "demo.sqlite");
const EXPERIMENT_DATABASE_PATH = resolve(DATA_DIR, "recovery-experiment.sqlite");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONTEXT = BACKGROUND_CONTEXT;
const LOCAL_MODEL_BASE_URL = normalizeBaseUrl(
  process.env.LOCAL_MODEL_BASE_URL ??
    process.env.VLLM_BASE_URL ??
    process.env.LLAMA_BASE_URL ??
    "http://127.0.0.1:8000/v1",
);
const LOCAL_MODEL_NAME =
  process.env.LOCAL_MODEL_NAME ??
  process.env.VLLM_MODEL ??
  process.env.LLAMA_MODEL ??
  "mlx-community/Qwen2.5-3B-Instruct-4bit";

const HELP = [
  "",
  "命令：",
  "  /help       显示帮助",
  "  /inspect    查看 SQLite 中的任务和 submission",
  "  /resume     重新启用 Harness 调度器",
  "  /fresh      清空 SQLite 会话并重新开始",
  "  /quit       退出 TUI",
  "",
  "普通输入会提交给 Agent。可用工具：read、write、edit、bash。",
  "",
].join("\n");

function normalizeBaseUrl(value) {
  const trimmed = value.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : trimmed + "/v1";
}

function createLocalProvider() {
  const model = {
    id: LOCAL_MODEL_NAME,
    name: LOCAL_MODEL_NAME + " (local OpenAI-compatible server)",
    api: "openai-completions",
    provider: "local",
    baseUrl: LOCAL_MODEL_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };

  return {
    provider: createProvider({
      id: "local",
      name: "Local OpenAI-compatible server",
      baseUrl: LOCAL_MODEL_BASE_URL,
      auth: {
        apiKey: {
          name: "Local server",
          resolve: async () => ({ auth: { apiKey: "local" } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
    modelRef: { provider: "local", modelId: LOCAL_MODEL_NAME },
  };
}

function createPauseExtension() {
  const pauseTool = defineTool({
    name: "durable_pause",
    description:
      "Pause for a specified number of milliseconds. This tool is only for the Pi Durable crash-recovery experiment.",
    parameters: Type.Object({ milliseconds: Type.Number() }),
    replay: "safe",
    execute: async ({ milliseconds }) => {
      const duration = Math.max(1000, Math.min(Math.trunc(milliseconds), 30000));
      process.stdout.write("DURABLE_PAUSE_STARTED:" + duration + "\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, duration));
      process.stdout.write("DURABLE_PAUSE_FINISHED\n");
      return {
        output: [{ type: "text", text: "durable_pause finished after " + duration + " ms" }],
      };
    },
  });

  return defineExtension({ name: "experiment-tools", tools: [pauseTool] });
}

async function createDurableHarness(options = {}) {
  const databasePath = options.databasePath ?? DATABASE_PATH;
  const experiment = options.experiment === true;
  await mkdir(DATA_DIR, { recursive: true });

  const models = createModels();
  const local = createLocalProvider();
  models.setProvider(local.provider);

  const registry = createRegistry();
  const codingTools = createCodingTools();
  const extensions = [codingTools];
  registry.install(codingTools);
  if (experiment) {
    const pauseExtension = createPauseExtension();
    extensions.push(pauseExtension);
    registry.install(pauseExtension);
  }

  const storage = await openNodeSqliteStorage(databasePath);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? PROJECT_ROOT }),
      onReport: (error, info) => {
        console.error("[Pi Durable report] " + info.type + ":", error?.message ?? error);
      },
    },
    CONTEXT,
  );

  const instructions = experiment
    ? "这是一次 Pi Durable 恢复实验。你必须先调用 durable_pause 工具，参数 milliseconds=20000；调用完成后再回答 pause completed。在调用 durable_pause 前不要直接回答，也不要使用其他工具。"
    : "你是一个简洁的中文终端助手。用户询问 demo-task.txt 时，先使用 read 工具读取它，再回答。解释 Pi Durable 时，说明 SQLite 持久化、submission、工具检查点和 resume。你可以按用户要求使用 read、write、edit、bash 工具；不要擅自修改文件或执行危险命令。";

  const root = await harness.root(CONTEXT, {
    agent: {
      extensions,
      model: local.modelRef,
      cwd: PROJECT_ROOT,
      instructions,
    },
  });
  await root.configure({ extensions, instructions }, CONTEXT);
  harness.resume();
  return { harness, root, storage };
}

async function resetDatabase(databasePath = DATABASE_PATH) {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(databasePath + "-wal", { force: true }),
    rm(databasePath + "-shm", { force: true }),
  ]);
}

async function closeDurableHarness(state) {
  await state.harness.close(CONTEXT);
  await state.storage.close?.();
}

async function answerFor(root, settled) {
  if (settled.status !== "done" || settled.type !== "input") return undefined;
  return root.commit((tx) => tx.entry(AssistantEntry, settled.answer), CONTEXT);
}

function assistantText(message) {
  const modelMessage = message?.model?.[0] ?? message;
  return (modelMessage?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function checkModelServer() {
  try {
    const response = await fetch(LOCAL_MODEL_BASE_URL + "/models");
    return response.ok;
  } catch {
    return false;
  }
}

function printModelServerHint() {
  console.error("未连接到本地模型服务：" + LOCAL_MODEL_BASE_URL);
  console.error("\n如果使用 vLLM：");
  console.error(
    "  vllm serve /Volumes/rzhu-SSD/models/mlx-community/Qwen2.5-3B-Instruct-4bit --served-model-name mlx-community/Qwen2.5-3B-Instruct-4bit --host 127.0.0.1 --port 8000 --enable-auto-tool-choice --tool-call-parser hermes --chat-template /Users/rzhu/Documents/Workplace/dev/pi-durable-demo/data/qwen25-chat-template.jinja",
  );
  console.error("\n如果严格复现 PDF 中的 llama.cpp 配置：");
  console.error("  llama-server -m /path/to/Qwen3.5-0.8B-BF16.gguf --host 127.0.0.1 --port 8080");
  console.error("  LLAMA_BASE_URL=http://127.0.0.1:8080/v1 LLAMA_MODEL=Qwen3.5-0.8B npm run demo -- --task\n");
}

function formatFailure(settled) {
  if (!settled.reason) return "任务没有返回结果。";
  return "任务未完成：" + settled.reason + (settled.detail ? " - " + settled.detail : "");
}

async function latestEntries(root) {
  const page = await root.entries({ order: "ascending" }, 1000, undefined, CONTEXT);
  return page.items;
}

function entryId(entry) {
  return Number(entry.id);
}

function showDurableEntries(entries, afterId) {
  for (const entry of entries) {
    if (entryId(entry) <= afterId) continue;
    const message = entry.model?.[0];
    if (!message) continue;

    if (entry.kind === "pi.assistant") {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "toolCall") {
          console.log("  ↳ tool " + block.name + "(" + JSON.stringify(block.arguments) + ")");
        }
      }
    } else if (entry.kind === "pi.tool-result") {
      const text = (message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      const preview = text.length > 500 ? text.slice(0, 500) + "…" : text;
      console.log("  ↳ tool result" + (message.isError ? " [error]" : "") + ": " + preview);
    }
  }
}

async function showInspection(harness) {
  const inspection = await harness.inspect(CONTEXT);
  const pending = inspection.submissions.filter(
    (submission) => submission.status === "queued" || submission.status === "placed",
  );
  console.log(
    "调度器：" +
      inspection.scheduling +
      "；活动任务：" +
      inspection.tasks.length +
      "；未完成 submission：" +
      pending.length,
  );
  for (const submission of pending) {
    console.log("  - " + submission.id + " (" + submission.status + ")");
  }
}

async function runCli(args) {
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: npm run demo -- [--fresh] [--task] [prompt]");
    console.log("       npm run tui");
    console.log("       npm run resume");
    console.log("       npm run experiment");
    return;
  }

  if (args.includes("--fresh")) {
    await resetDatabase();
    console.log("已清理本地 SQLite 会话。\n");
  }

  const task = args.includes("--task");
  const prompt = task
    ? "请读取 data/demo-task.txt，并解释 Pi Durable 为什么有用。"
    : args.filter((arg) => arg !== "--fresh").join(" ").trim();

  if (!prompt) {
    console.error("请输入 prompt 或使用 --task。");
    process.exitCode = 1;
    return;
  }
  if (!(await checkModelServer())) {
    printModelServerHint();
    process.exitCode = 1;
    return;
  }

  const state = await createDurableHarness();
  try {
    const requestId = "cli-" + randomUUID();
    console.log("Pi Durable submission: " + requestId);
    console.log("模型：" + LOCAL_MODEL_NAME);
    console.log("服务：" + LOCAL_MODEL_BASE_URL);
    console.log("正在运行……\n");
    const submission = await state.root.submit(
      { type: "input", content: prompt, requestId },
      CONTEXT,
    );
    const settled = await submission.wait(CONTEXT);
    const answer = await answerFor(state.root, settled);
    if (answer) console.log(assistantText(answer));
    else {
      console.error(formatFailure(settled));
      process.exitCode = 1;
    }
  } finally {
    await closeDurableHarness(state);
  }
}

async function runTui() {
  if (!(await checkModelServer())) {
    printModelServerHint();
    process.exitCode = 1;
    return;
  }

  let state = await createDurableHarness();
  const rl = createInterface({ input, output, terminal: true });
  const closeState = async () => closeDurableHarness(state);

  try {
    console.log("╭──────────────────────────────────────────────╮");
    console.log("│ Pi Durable · vLLM · Interactive TUI          │");
    console.log("╰──────────────────────────────────────────────╯");
    console.log("模型：" + LOCAL_MODEL_NAME);
    console.log("服务：" + LOCAL_MODEL_BASE_URL);
    console.log("SQLite：" + DATABASE_PATH);
    console.log("输入 /help 查看命令；输入 /quit 退出。\n");
    await showInspection(state.harness);
    console.log(HELP);

    while (true) {
      let line;
      try {
        line = (await rl.question("你> ")).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        console.log(HELP);
        continue;
      }
      if (line === "/inspect") {
        await showInspection(state.harness);
        continue;
      }
      if (line === "/resume") {
        state.harness.resume();
        console.log("已调用 Harness.resume()。");
        await showInspection(state.harness);
        continue;
      }
      if (line === "/fresh") {
        await closeState();
        await resetDatabase();
        state = await createDurableHarness();
        console.log("已清理 SQLite，会话重新开始。\n");
        continue;
      }

      const before = await latestEntries(state.root);
      const lastId = before.length === 0 ? 0 : entryId(before.at(-1));
      const requestId = "tui-" + randomUUID();
      console.log("\n[Pi Durable] submission " + requestId);
      console.log("[Pi Durable] 已持久化输入，等待模型和工具任务……");

      try {
        const submission = await state.root.submit(
          { type: "input", content: line, requestId },
          CONTEXT,
        );
        const settled = await submission.wait(CONTEXT);
        showDurableEntries(await latestEntries(state.root), lastId);
        const answer = await answerFor(state.root, settled);
        if (answer) console.log("Agent> " + assistantText(answer) + "\n");
        else console.log(formatFailure(settled) + "\n");
      } catch (error) {
        console.error("[Pi Durable] 提交失败：" + error.message + "\n");
      }
    }
  } finally {
    rl.close();
    await closeState();
  }
}

async function runResume() {
  if (!(await checkModelServer())) {
    printModelServerHint();
    process.exitCode = 1;
    return;
  }

  const state = await createDurableHarness();
  try {
    const inspection = await state.harness.inspect(CONTEXT);
    const pending = inspection.submissions.filter(
      (submission) => submission.status === "queued" || submission.status === "placed",
    );
    console.log("已打开 SQLite，会话中有 " + pending.length + " 个未完成 submission。");
    console.log("模型服务：" + LOCAL_MODEL_BASE_URL);
    state.harness.resume();

    if (pending.length === 0) {
      console.log("没有需要恢复的 submission。请先运行 npm run demo -- --task。");
      return;
    }
    const record = pending[pending.length - 1];
    const submission = await state.harness.submission(record.id, CONTEXT);
    if (!submission) throw new Error("找不到 submission " + record.id);
    const settled = await submission.wait(CONTEXT);
    const answer = await answerFor(state.root, settled);
    if (answer) console.log(assistantText(answer));
    else {
      console.error(formatFailure(settled));
      process.exitCode = 1;
    }
  } finally {
    await closeDurableHarness(state);
  }
}

function databaseSnapshot(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const counts = db
    .prepare(
      "select 'conversations' as table_name,count(*) as rows from conversations union all " +
        "select 'entries',count(*) from entries union all select 'submissions',count(*) from submissions union all " +
        "select 'tasks',count(*) from tasks union all select 'documents',count(*) from documents union all " +
        "select 'document_revisions',count(*) from document_revisions",
    )
    .all();
  const tasks = db
    .prepare(
      "select id,kind,status,json_extract(record,'$.state.status') as state_status," +
        "json_extract(record,'$.state.outcome.status') as outcome_status from tasks order by id",
    )
    .all();
  const submissions = db
    .prepare(
      "select id,request_id,status,json_extract(record,'$.entry') as entry_id," +
        "json_extract(record,'$.answer') as answer_id from submissions order by id",
    )
    .all();
  const entries = db
    .prepare(
      "select id,json_extract(record,'$.kind') as kind," +
        "json_extract(record,'$.model[0].role') as role," +
        "json_extract(record,'$.model[0].toolName') as tool_name," +
        "json_extract(record,'$.model[0].stopReason') as stop_reason from entries order by id",
    )
    .all();
  db.close();
  return { counts, tasks, submissions, entries };
}

function printSnapshot(label, snapshot) {
  console.log("\n===== " + label + " =====");
  console.log(JSON.stringify(snapshot, null, 2));
}

function waitForExit(child) {
  return new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function waitForMarker(child, marker, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error("等待子进程标记超时：" + marker + "\n" + stdout + stderr));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes(marker)) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new Error("子进程提前退出 code=" + code + " signal=" + signal + "\n" + stdout + stderr),
      );
    });
  });
}

function collectProcess(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return waitForExit(child).then((exit) => ({ ...exit, stdout, stderr }));
}

async function runExperimentWorker(kind) {
  const databasePath = process.env.PI_DURABLE_DATABASE ?? EXPERIMENT_DATABASE_PATH;
  if (!(await checkModelServer())) {
    printModelServerHint();
    process.exitCode = 1;
    return;
  }

  const state = await createDurableHarness({ databasePath, experiment: true });
  try {
    if (kind === "run") {
      console.log("WORKER_READY");
      const submission = await state.root.submit(
        {
          type: "input",
          content:
            "这是一次恢复实验。必须先调用 durable_pause 工具，参数 milliseconds=20000；调用完成后再回答 pause completed。",
          requestId: "recovery-experiment-001",
        },
        CONTEXT,
      );
      console.log("WORKER_SUBMITTED:" + submission.id);
      const settled = await submission.wait(CONTEXT);
      const answer = await answerFor(state.root, settled);
      console.log(answer ? "WORKER_FINISHED:" + assistantText(answer) : formatFailure(settled));
    } else if (kind === "resume") {
      const inspection = await state.harness.inspect(CONTEXT);
      const pending = inspection.submissions.filter(
        (submission) => submission.status === "queued" || submission.status === "placed",
      );
      console.log("RESUME_PENDING:" + pending.length);
      if (pending.length === 0) {
        throw new Error("恢复实验没有找到未完成 submission");
      }
      const record = pending[pending.length - 1];
      const submission = await state.harness.submission(record.id, CONTEXT);
      if (!submission) throw new Error("恢复实验找不到 submission " + record.id);
      const settled = await submission.wait(CONTEXT);
      const answer = await answerFor(state.root, settled);
      console.log(answer ? "RECOVERED:" + assistantText(answer) : formatFailure(settled));
    } else {
      throw new Error("未知实验 worker 模式：" + kind);
    }
  } finally {
    await closeDurableHarness(state);
  }
}

async function runExperiment() {
  if (!(await checkModelServer())) {
    printModelServerHint();
    process.exitCode = 1;
    return;
  }

  await resetDatabase(EXPERIMENT_DATABASE_PATH);
  const env = { ...process.env, PI_DURABLE_DATABASE: EXPERIMENT_DATABASE_PATH };
  console.log("开始 Durable 中断恢复实验。");
  console.log("实验数据库：" + EXPERIMENT_DATABASE_PATH);

  const worker = spawn(process.execPath, [SCRIPT_PATH, "--worker", "run"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForMarker(worker, "DURABLE_PAUSE_STARTED", 60000);
  console.log("子进程已进入 durable_pause，立即强制终止。");
  worker.kill("SIGKILL");
  const killed = await waitForExit(worker);
  console.log("中断结果：code=" + killed.code + " signal=" + killed.signal);
  printSnapshot("INTERRUPTED SNAPSHOT", databaseSnapshot(EXPERIMENT_DATABASE_PATH));

  const resumedWorker = spawn(process.execPath, [SCRIPT_PATH, "--worker", "resume"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const resumed = await collectProcess(resumedWorker);
  process.stdout.write(resumed.stdout);
  process.stderr.write(resumed.stderr);
  if (resumed.code !== 0) {
    throw new Error("恢复子进程失败 code=" + resumed.code + " signal=" + resumed.signal);
  }
  printSnapshot("RECOVERED SNAPSHOT", databaseSnapshot(EXPERIMENT_DATABASE_PATH));
  console.log("\n实验完成：同一个 SQLite 中的未完成 submission 已由新的 Harness 进程恢复。");
}

const args = process.argv.slice(2);
if (args[0] === "--tui") {
  await runTui();
} else if (args[0] === "--resume") {
  await runResume();
} else if (args[0] === "--experiment") {
  await runExperiment();
} else if (args[0] === "--worker") {
  await runExperimentWorker(args[1]);
} else {
  await runCli(args);
}
