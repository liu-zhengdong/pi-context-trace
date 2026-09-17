import assert from "node:assert/strict";
import { Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startViewer, type ViewerStatus } from "../src/server.ts";
import { TraceStore } from "../src/store.ts";
import { workspace } from "./helpers.ts";

const status = (): ViewerStatus => ({
  enabled: false,
  sessionId: "test",
  revision: 0,
  error: null,
  pending: 0,
});

test("viewer reuses the preferred port and falls back only while it is occupied", async (t) => {
  const store = new TraceStore(join(workspace(t), "trace.sqlite"));
  t.after(() => store.close());
  const probe = await startViewer(store, status, 0);
  const port = Number(new URL(probe.url).port);
  await probe.close();

  const preferred = await startViewer(store, status, port);
  try {
    assert.equal(preferred.url, `http://127.0.0.1:${port}`);
    const fallback = await startViewer(store, status, port);
    try {
      assert.notEqual(fallback.url, preferred.url);
      assert.equal(new URL(fallback.url).hostname, "127.0.0.1");
      const response = await fetch(`${fallback.url}/api/status`);
      assert.deepEqual(await response.json(), status());
      assert.equal(
        (
          await fetch(`${fallback.url}/api/status`, {
            headers: { origin: preferred.url },
          })
        ).status,
        403,
      );
    } finally {
      await fallback.close();
    }
  } finally {
    await preferred.close();
  }
  const reopened = await startViewer(store, status, port);
  t.after(() => reopened.close());
  assert.equal(reopened.url, preferred.url);
});

test("viewer defaults to port 4318 and does not hide other listen errors", async (t) => {
  const store = new TraceStore(join(workspace(t), "trace.sqlite"));
  t.after(() => store.close());
  const failure = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const listen = t.mock.method(
    Server.prototype,
    "listen",
    function (this: Server) {
      queueMicrotask(() => this.emit("error", failure));
      return this;
    },
  );
  await assert.rejects(
    startViewer(store, status),
    (error) => error === failure,
  );
  assert.equal(listen.mock.callCount(), 1);
  assert.equal(listen.mock.calls[0]?.arguments[0], 4318);
  assert.equal(listen.mock.calls[0]?.arguments[1], "127.0.0.1");
});
