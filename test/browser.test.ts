import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openBrowser } from "../src/browser.ts";

const url = "http://127.0.0.1:4318";
const success = { stdout: "", stderr: "", code: 0, killed: false };

test("browser launcher uses platform commands with an argument array and bounded timeout", async () => {
  const cases: [NodeJS.Platform, string, string[]][] = [
    ["darwin", "open", [url]],
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", url]],
    ["linux", "xdg-open", [url]],
  ];
  for (const [platform, expectedCommand, expectedArgs] of cases) {
    const exec: ExtensionAPI["exec"] = async (command, args, options) => {
      assert.equal(command, expectedCommand);
      assert.deepEqual(args, expectedArgs);
      assert.equal(options?.timeout, 5000);
      return success;
    };
    await openBrowser(url, exec, platform);
  }
});

test("browser launcher reports exit failures, timeouts and missing commands", async () => {
  await assert.rejects(
    openBrowser(url, async () => ({
      ...success,
      code: 1,
      stderr: "no browser",
    })),
    /no browser/,
  );
  await assert.rejects(
    openBrowser(url, async () => ({ ...success, code: 2 })),
    /退出：2/,
  );
  await assert.rejects(
    openBrowser(url, async () => ({ ...success, killed: true })),
    /超时/,
  );
  await assert.rejects(
    openBrowser(url, async () => {
      throw new Error("ENOENT");
    }),
    /ENOENT/,
  );
});
