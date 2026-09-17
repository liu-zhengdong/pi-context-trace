import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import contextTrace from "../src/index.ts";
import { workspace } from "./helpers.ts";

test("trace commands open the ready viewer; browser failure and headless modes preserve capture", async (t) => {
  const root = workspace(t);
  const notifications: { text: string; level: string }[] = [];
  const opened: { url: string; enabled: boolean }[] = [];
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let browserFails = false;
  const exec: ExtensionAPI["exec"] = async (_command, args) => {
    const url = args?.at(-1);
    assert.ok(url);
    const response = await fetch(`${url}/api/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    opened.push({ url, enabled: status.enabled });
    if (browserFails) throw new Error("browser unavailable");
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  contextTrace({
    registerFlag() {},
    getFlag: () => root,
    registerCommand(_name: string, options: NonNullable<typeof command>) {
      command = options;
    },
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_shutdown") shutdown = handler;
    },
    exec,
  } as unknown as ExtensionAPI);
  assert.ok(command);
  const { handler } = command;
  t.after(async () => {
    await shutdown?.();
  });
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "command-test" },
    ui: {
      setStatus() {},
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
    },
  } as unknown as ExtensionCommandContext;
  const run = (action: string) => handler(action, ctx);

  await run("on");
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.enabled, true);
  const url = opened[0]?.url;
  assert.ok(url);
  assert.ok(notifications.some(({ text }) => text.includes(url)));
  await run("off");
  assert.equal(opened.length, 1);
  await run("ui");
  assert.deepEqual(opened[1], { url, enabled: false });
  await run("on");
  assert.deepEqual(opened[2], { url, enabled: true });
  await run("path");
  assert.ok(
    notifications.some(({ text }) => text === join(root, "trace.sqlite")),
  );
  await run("");
  await run("off");
  assert.equal(opened.length, 3);

  browserFails = true;
  await run("on");
  assert.deepEqual(opened[3], { url, enabled: true });
  assert.ok(
    notifications.some(
      ({ text, level }) =>
        level === "warning" &&
        text.includes("browser unavailable") &&
        text.includes(url),
    ),
  );
  assert.equal(
    notifications.some(({ level }) => level === "error"),
    false,
  );
  const response = await fetch(`${url}/api/status`);
  assert.equal((await response.json()).enabled, true);

  for (const mode of ["print", "json", "rpc"] as const) {
    ctx.mode = mode;
    await run("off");
    await run("on");
    await run("ui");
  }
  assert.equal(opened.length, 4);
});
