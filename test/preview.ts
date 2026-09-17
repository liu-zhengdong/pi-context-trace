import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceController } from "../src/controller.ts";
import { meta } from "./helpers.ts";

const root = mkdtempSync(join(tmpdir(), "pi-context-trace-preview-"));
const controller = new TraceController(join(root, "trace.sqlite"));
const url = await controller.enable();
controller.state.sessionId = "demo-context-audit";
const instructions =
  "你是 Pi，一个在本地工作的编程助手。\n\n使用经历记忆接续上下文，保留近期 Run 的原始轨迹。只在缺少必要细节时主动展开历史证据。\n\n当前项目：pi-experience\n语言偏好：中文";
const tools = [
  {
    type: "function",
    name: "search_memory",
    description: "检索已经保存的 Run 和 Experience。",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "get_run",
    description: "按需阅读某次 Run 的目标、结论与执行轨迹。",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "read",
    description: "读取本地文件。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];
const overview = {
  role: "user",
  content:
    "<experience>\nE01 · 上下文接续方案\nRun 绑定 Session；Experience 可跨 Session 归并。近期完整轨迹默认预算 80k，历史概要预算 20k。\n</experience>",
};
const first = {
  role: "user",
  content: "帮我看一下，上一轮的完整对话还在上下文里吗？",
};
const answer = {
  role: "assistant",
  content:
    "上一轮的完整对话仍在本次请求中。当前上下文按系统指令、Experience 概要和近期 Run 原文排列，无需重复调用 get_run 获取已经可见的证据。",
};
const payloads = [
  {
    model: "gpt-6-astra",
    instructions,
    input: [overview, first],
    tools,
    reasoning: { effort: "high" },
    stream: true,
  },
  {
    model: "gpt-6-astra",
    instructions,
    input: [
      overview,
      first,
      answer,
      {
        role: "user",
        content: "如果把这条 Run 收起，下一次发送的上下文会如何变化？",
      },
    ],
    tools,
    reasoning: { effort: "high" },
    stream: true,
  },
  {
    model: "gpt-6-astra",
    instructions,
    input: [
      {
        role: "user",
        content:
          "<experience>\nE01 · 上下文接续方案\n近期 Run 已核对：原文曾保留在上下文中，保存 Experience 后按用户要求收起；记录仍可按需展开。\n</experience>",
      },
      {
        role: "user",
        content: "再看一下这次请求：哪些内容被收起了，哪些内容是新增的？",
      },
    ],
    tools,
    reasoning: { effort: "high" },
    stream: true,
  },
];
for (const [index, payload] of payloads.entries()) {
  controller.capture(payload, {
    ...meta("demo-context-audit"),
    provider: "openai-codex",
    model: "gpt-6-astra",
    sessionName: "上下文接续 · 审计示例",
  });
  controller.complete("demo-context-audit", {
    role: "assistant",
    content: [
      {
        type: "text",
        text:
          index === 2
            ? "这次请求移除了旧 Run 的两条原文消息，更新了 Experience 概要，并加入了新的用户问题。系统指令和工具定义保持不变。"
            : answer.content,
      },
    ],
    usage: { input: 3180 + index * 250, output: 146, cacheRead: 2800 },
  });
}
await controller.flush();
console.log(`Preview: ${url}`);
const keepAlive = setInterval(() => {}, 60000);
async function stop(): Promise<void> {
  clearInterval(keepAlive);
  await controller.close();
  rmSync(root, { recursive: true, force: true });
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
