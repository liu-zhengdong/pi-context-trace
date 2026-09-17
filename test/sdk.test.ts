import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { TraceStore } from "../src/store.ts";
import { workspace } from "./helpers.ts";

test("real Pi provider serializer: snapshots equal sent bodies after context hooks; on/off/reload are isolated", {
  timeout: 30000,
}, async (t) => {
  const root = workspace(t);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const sent: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `${[
          {
            id: `mock-${sent.length}`,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: `answer ${sent.length}` },
                finish_reason: null,
              },
            ],
          },
          {
            id: `mock-${sent.length}`,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 21,
              completion_tokens: 3,
              total_tokens: 24,
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("")}data: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("fixture", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture-not-a-secret",
    models: [
      {
        id: "mock",
        name: "Mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 2000,
      },
    ],
  });
  const model = runtime.getModel("fixture", "mock");
  assert.ok(model);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
    extensionFactories: [
      (pi) => {
        pi.on("context", (event) => ({
          messages: [
            {
              role: "user",
              content: "Experience injection fixture",
              timestamp: Date.now(),
            },
            ...event.messages,
          ],
        }));
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  loader.getExtensions().runtime.flagValues.set("context-trace-dir", root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
    resourceLoader: loader,
    tools: [],
  });
  const errors: string[] = [];
  await session.bindExtensions({
    onError: (event) => errors.push(event.error),
  });
  t.after(async () => {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  });
  const path = join(root, "trace.sqlite");
  await session.prompt("off request");
  assert.equal(sent.length, 1);
  assert.equal(existsSync(path), false);
  await session.prompt("/trace on");
  await session.prompt("first captured request");
  await session.prompt("second captured request");
  await session.prompt("/trace off");
  await session.prompt("off again");
  const reader = new TraceStore(path);
  t.after(() => reader.close());
  const page = reader.list(session.sessionManager.getSessionId());
  assert.equal(page.total, 2);
  const first = await reader.detail(page.results[1]?.id ?? "");
  const second = await reader.detail(page.results[0]?.id ?? "");
  assert.deepEqual(first?.payload, sent[1]);
  assert.deepEqual(second?.payload, sent[2]);
  assert.match(JSON.stringify(first?.payload), /Experience injection fixture/);
  assert.match(JSON.stringify(second?.payload), /answer 2/);
  assert.match(JSON.stringify(second?.response), /answer 3/);
  assert.equal(sent.length, 4);
  assert.deepEqual(errors, []);
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "reload",
  });
  await session.extensionRunner.emit({
    type: "session_start",
    reason: "reload",
  });
  await session.prompt("reload stays off");
  assert.equal(reader.list(session.sessionManager.getSessionId()).total, 2);
  assert.deepEqual(errors, []);
});
