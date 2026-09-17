import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { startViewer } from "../../src/server.ts";
import { TraceStore } from "../../src/store.ts";
import { meta, workspace } from "../helpers.ts";

async function selected(page: Page, name: string): Promise<void> {
  await page.locator(`#tab-${name}[aria-selected=true]`).waitFor();
  assert.equal(
    await page.locator("#content").getAttribute("aria-labelledby"),
    `tab-${name}`,
  );
}

// Separate from the Node-only suite: npm run test:ui after installing a Playwright browser.
test("viewer exposes categories directly, even with a large tool list", {
  timeout: 60000,
}, async (t) => {
  const store = new TraceStore(join(workspace(t), "trace.sqlite"));
  t.after(() => store.close());
  const older = meta();
  await store.capture(older, JSON.stringify({ messages: [], tools: [] }));
  const latest = meta();
  const payload = {
    model: "fixture-model",
    instructions: "system-only-needle",
    messages: Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
      ...(index === 0 ? { metadata: "message-metadata-needle" } : {}),
    })),
    tools: Array.from({ length: 120 }, (_, index) => ({
      name: `tool_${index}`,
      description:
        index === 70 ? "tools-only-needle" : `Tool definition ${index}`,
      parameters: { type: "object", properties: { path: { type: "string" } } },
    })),
    temperature: 0.2,
  };
  await store.capture(latest, JSON.stringify(payload));
  let revision = 1;
  const viewer = await startViewer(
    store,
    () => ({
      enabled: true,
      sessionId: latest.sessionId,
      revision,
      error: null,
      pending: 0,
    }),
    0,
  );
  t.after(() => viewer.close());
  const browser = await chromium.launch({
    ...(process.env.PI_CONTEXT_TRACE_BROWSER_CHANNEL
      ? { channel: process.env.PI_CONTEXT_TRACE_BROWSER_CHANNEL }
      : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(viewer.url);
  await selected(page, "messages");

  await t.test(
    "defaults to messages with no system or tool cards in the panel",
    async () => {
      assert.equal(await page.getByRole("tab").count(), 7);
      assert.equal(await page.locator("#content .context-card").count(), 60);
      assert.equal(
        await page.locator("#content .path").first().textContent(),
        "messages[0]",
      );
      assert.equal(
        await page.locator("#tab-tools .tab-count").textContent(),
        "120",
      );
      assert.equal(
        await page
          .locator("#content")
          .textContent()
          .then((text) => text?.includes("Tool definition")),
        false,
      );
    },
  );

  await t.test(
    "sticky navigation returns to the next category's start and retains card state",
    async () => {
      await page.locator("#content .context-card > summary").first().click();
      await page.locator("#content .context-card[open]").first().waitFor();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.locator("#tab-tools").click();
      await selected(page, "tools");
      assert.equal(await page.locator("#content .context-card").count(), 120);
      assert.ok(
        await page
          .locator("#content .context-card")
          .first()
          .evaluate((node) => {
            const toolbar = document.getElementById("toolbar");
            if (!toolbar) return false;
            const top = node.getBoundingClientRect().top;
            return (
              top >= toolbar.getBoundingClientRect().bottom &&
              top < window.innerHeight
            );
          }),
      );
      await page.locator("#collapse-all").click();
      await page.locator("#tab-messages").click();
      assert.equal(
        await page
          .locator("#content .context-card")
          .first()
          .getAttribute("open"),
        "",
      );
    },
  );

  await t.test(
    "search exposes matches across categories and includes full original fields",
    async () => {
      await page.locator("#search").fill("tools-only-needle");
      await page.waitForFunction(
        () =>
          document.querySelector("#tab-tools .tab-count")?.textContent ===
          "1/120",
      );
      assert.equal(
        await page.locator("#tab-messages .tab-count").textContent(),
        "0/60",
      );
      await page.locator("#content .no-results").waitFor();
      await page.locator("#tab-tools").click();
      assert.equal(await page.locator("#content .context-card").count(), 1);
      assert.equal(
        await page.locator("#content .path").textContent(),
        "tools[70]",
      );
      assert.ok((await page.locator("#content mark").count()) > 0);
      await page.locator("#search").fill("message-metadata-needle");
      await page.waitForFunction(
        () =>
          document.querySelector("#tab-messages .tab-count")?.textContent ===
          "1/60",
      );
      await page.locator("#tab-messages").click();
      assert.equal(await page.locator("#content .context-card").count(), 1);
      await page.locator("#search").fill("");
      await page.waitForFunction(
        () =>
          document.querySelector("#tab-messages .tab-count")?.textContent ===
          "60",
      );
    },
  );

  await t.test(
    "output has an explicit empty state and updates without changing the selected tab",
    async () => {
      await page.locator("#tab-response").click();
      assert.match(
        await page.locator("#content").innerText(),
        /尚未记录本次输出/,
      );
      await store.complete(
        latest.id,
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "response-only-needle" }],
        }),
      );
      revision++;
      await page
        .getByText("response-only-needle", { exact: true })
        .last()
        .waitFor();
      await selected(page, "response");
      assert.match(
        await page.locator("#view-note").innerText(),
        /不属于请求 payload/,
      );
      await page.locator("#collapse-all").click();
      await page.locator("#tab-messages").click();
      await page.locator("#tab-response").click();
      assert.equal(
        await page.locator("#content .context-card[open]").count(),
        0,
      );
    },
  );

  await t.test(
    "request switching keeps the category and empty categories remain reachable",
    async () => {
      await page.locator("#tab-tools").click();
      await page.locator(".request-row").nth(1).click();
      await page.getByText("本次请求没有工具定义。", { exact: true }).waitFor();
      await selected(page, "tools");
      assert.equal(
        await page.locator("#tab-tools .tab-count").textContent(),
        "0",
      );
      await page.locator("#tab-settings").click();
      assert.match(await page.locator("#content").innerText(), /没有生成参数/);
      await page.locator(".request-row").first().click();
      await page.locator("#content .context-card").waitFor();
      await selected(page, "settings");
    },
  );

  await t.test(
    "keyboard tabs, diff, raw JSON and full export still work",
    async () => {
      await page.locator("#tab-settings").focus();
      await page.keyboard.press("ArrowLeft");
      await selected(page, "tools");
      await page.keyboard.press("Home");
      await selected(page, "messages");
      await page.keyboard.press("End");
      await selected(page, "raw");
      await page.locator(".json-tree").waitFor();
      await page.keyboard.press("ArrowRight");
      await selected(page, "messages");
      await page.keyboard.press("ArrowLeft");
      await selected(page, "raw");
      assert.equal(await page.locator('[role=tab][tabindex="0"]').count(), 1);
      await page.locator("#tab-diff").click();
      await page.locator(".diff-intro").waitFor();
      assert.match(await page.locator(".diff-intro").innerText(), /60 条新增/);
      await page.locator("#tab-system").click();
      await page.locator("#expand-all").click();
      await page.locator("#content .card-text").waitFor();
      assert.equal(
        await page.locator("#content .card-text").first().textContent(),
        "system-only-needle",
      );
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#download").click();
      const download = await downloadEvent;
      assert.deepEqual(
        JSON.parse(await readFile(await download.path(), "utf8")),
        payload,
      );
    },
  );

  await t.test(
    "narrow screens scroll the tab row, not the page width, in both themes",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await page.locator("#tab-messages").click();
        assert.ok(
          await page
            .locator("#tabs")
            .evaluate((node) => node.scrollWidth > node.clientWidth),
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        );
        await page.locator("#tab-raw").click();
        await selected(page, "raw");
        await page.locator(".json-tree").waitFor();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        );
      }
    },
  );
  assert.deepEqual(errors, []);
});
