import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { CaptureMeta } from "../src/store.ts";
export function workspace(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "pi-context-trace-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
export function meta(sessionId = "session-a"): CaptureMeta {
  return {
    id: randomUUID(),
    sessionId,
    sessionName: "测试会话",
    cwd: "/test",
    provider: "fixture",
    model: "fixture-model",
    api: "openai-responses",
    createdAt: new Date().toISOString(),
  };
}
