import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TraceController } from "../src/controller.ts";
import { TraceStore } from "../src/store.ts";
import { meta, workspace } from "./helpers.ts";

test("off is inert; capture freezes exact payload; off drains writes and rejects later responses", async (t) => {
  const path = join(workspace(t), "trace.sqlite");
  const controller = new TraceController(path);
  t.after(() => controller.close());
  controller.capture({ input: "ignored" }, meta());
  assert.equal(existsSync(path), false);
  const url = await controller.enable();
  const payload = {
    instructions: "unchanged",
    input: [{ role: "user", content: "原文" }],
    tools: [],
  };
  const original = structuredClone(payload);
  controller.capture(payload, meta());
  payload.input[0] = { role: "user", content: "mutated later" };
  controller.complete("session-a", { role: "assistant", content: "reply" });
  await controller.disable();
  controller.capture({ input: "off" }, meta());
  controller.complete("session-a", { content: "off" });
  const store = new TraceStore(path);
  t.after(() => store.close());
  const list = store.list("session-a");
  assert.equal(list.total, 1);
  const detail = await store.detail(list.results[0]?.id ?? "");
  assert.deepEqual(detail?.payload, original);
  assert.deepEqual(detail?.response, { role: "assistant", content: "reply" });
  assert.equal(controller.state.pending, 0);
  assert.equal(controller.state.enabled, false);
  assert.equal(
    (await fetch(`${url}/api/status`).then((response) => response.json()))
      .enabled,
    false,
  );
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await controller.enable(), url);
  controller.capture({ input: "capture resumed" }, meta());
  await controller.disable();
  assert.equal(store.list("session-a").total, 2);
});
test("history survives reopening and previous request stays inside the same session", async (t) => {
  const path = join(workspace(t), "trace.sqlite");
  let store = new TraceStore(path);
  const first = meta("a");
  const other = meta("b");
  const last = meta("a");
  await store.capture(first, JSON.stringify({ input: "first" }));
  await store.capture(other, JSON.stringify({ input: "other" }));
  await store.capture(
    last,
    JSON.stringify({ input: "last", data: "large".repeat(250_000) }),
  );
  store.close();
  store = new TraceStore(path);
  t.after(() => store.close());
  const detail = await store.detail(last.id);
  assert.equal(detail?.previousId, first.id);
  assert.equal(store.sessions().length, 2);
  assert.equal(JSON.stringify(detail?.payload).length > 1_000_000, true);
});
test("serialization and startup failures are reported without rejecting provider calls", async (t) => {
  const root = workspace(t);
  const path = join(root, "trace.sqlite");
  const controller = new TraceController(path);
  t.after(() => controller.close());
  await controller.enable();
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => controller.capture(cyclic, meta()));
  assert.equal(controller.state.enabled, false);
  assert.match(controller.state.error ?? "", /circular/i);
  const blockedPath = join(root, "file");
  writeFileSync(blockedPath, "not a directory");
  const invalid = new TraceController(join(blockedPath, "trace.sqlite"));
  await assert.rejects(invalid.enable());
});
test("SQLite write failure pauses capture and leaves provider transport untouched", async (t) => {
  const path = join(workspace(t), "trace.sqlite");
  const originalFetch = globalThis.fetch;
  const controller = new TraceController(path);
  t.after(() => controller.close());
  await controller.enable();
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_capture BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
  );
  assert.doesNotThrow(() => controller.capture({ input: "request" }, meta()));
  await controller.flush();
  assert.equal(controller.state.enabled, false);
  assert.equal(controller.state.pending, 0);
  assert.match(controller.state.error ?? "", /synthetic disk failure/);
  assert.equal(globalThis.fetch, originalFetch);
});
test("server serves UI/assets and rejects cross-origin requests, wrong hosts, writes and invalid IDs", async (t) => {
  const controller = new TraceController(join(workspace(t), "trace.sqlite"));
  t.after(() => controller.close());
  const url = await controller.enable();
  assert.match(
    await fetch(url).then((response) => response.text()),
    /Context Trace/,
  );
  assert.equal((await fetch(`${url}/style.css`)).status, 200);
  assert.equal(
    (
      await fetch(`${url}/api/status`, {
        headers: { origin: "https://unrelated.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      // Node fetch overwrites Host; use http to send the actual hostile header.
      httpGet(
        `${url}/api/status`,
        { headers: { host: "unrelated.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on("error", reject);
    }),
    403,
  );
  assert.equal(
    (await fetch(`${url}/api/status`, { method: "POST" })).status,
    405,
  );
  assert.equal((await fetch(`${url}/api/requests?offset=-1`)).status, 400);
  assert.equal((await fetch(`${url}/api/requests/not-an-id`)).status, 404);
  assert.equal((await fetch(`${url}/../package.json`)).status, 404);
});
test("pagination does not truncate the archive", async (t) => {
  const store = new TraceStore(join(workspace(t), "trace.sqlite"));
  t.after(() => store.close());
  for (let i = 0; i < 103; i++)
    await store.capture(meta(), JSON.stringify({ input: `request-${i}` }));
  const first = store.list("session-a");
  const second = store.list("session-a", first.nextOffset ?? 0);
  assert.equal(first.results.length, 100);
  assert.equal(first.total, 103);
  assert.equal(second.results.length, 3);
  assert.equal(second.nextOffset, null);
});
