import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { openBrowser } from "./browser.ts";
import { TraceController } from "./controller.ts";

export default function contextTrace(pi: ExtensionAPI): void {
  pi.registerFlag("context-trace-dir", {
    description: "Local context trace data directory",
    type: "string",
  });
  let controller: TraceController | undefined;
  let previousError: string | null = null;
  function get(): TraceController {
    if (!controller) {
      const flag = pi.getFlag("context-trace-dir");
      controller = new TraceController(
        join(
          typeof flag === "string"
            ? flag
            : join(homedir(), ".pi", "context-trace"),
          "trace.sqlite",
        ),
      );
    }
    return controller;
  }
  function update(ctx: ExtensionContext): void {
    const trace = get();
    trace.state.sessionId = ctx.sessionManager.getSessionId();
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "context-trace",
        trace.state.error
          ? "Trace · 保存失败"
          : trace.state.enabled
            ? "Trace ● 监听中"
            : undefined,
      );
      if (trace.state.error && trace.state.error !== previousError)
        ctx.ui.notify(`Trace 已暂停：${trace.state.error}`, "error");
    }
    previousError = trace.state.error;
  }
  async function launchBrowser(
    ctx: ExtensionContext,
    url: string,
  ): Promise<void> {
    if (ctx.mode !== "tui") return;
    try {
      await openBrowser(url, pi.exec);
    } catch (error) {
      ctx.ui.notify(
        `无法自动打开浏览器：${String(error)}\n请手动访问：${url}`,
        "warning",
      );
    }
  }
  pi.registerCommand("trace", {
    description: "上下文快照：on 开启 / off 关闭 / ui 查看 / path 日志路径",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "ui", "path"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trace = get();
      const action = args.trim();
      try {
        if (action === "on") {
          const url = await trace.enable();
          ctx.ui.notify(
            `Trace 已开启 · ${url}\n从下一次 provider 请求开始记录上下文。`,
            "info",
          );
          await launchBrowser(ctx, url);
        } else if (action === "off") {
          await trace.disable();
          ctx.ui.notify(
            `Trace 已关闭。已捕获的快照仍可查看${trace.url ? `：${trace.url}` : "。"}`,
            "info",
          );
        } else if (action === "ui") {
          const url = await trace.open();
          ctx.ui.notify(`上下文查看器 · ${url}`, "info");
          await launchBrowser(ctx, url);
        } else if (action === "path") {
          const flag = pi.getFlag("context-trace-dir");
          ctx.ui.notify(
            join(
              typeof flag === "string"
                ? flag
                : join(homedir(), ".pi", "context-trace"),
              "trace.sqlite",
            ),
            "info",
          );
        } else
          ctx.ui.notify(
            `Trace ${trace.state.enabled ? "监听中" : "已关闭"}${trace.url ? ` · ${trace.url}` : ""}\n/trace on · /trace off · /trace ui · /trace path`,
            "info",
          );
      } catch (error) {
        ctx.ui.notify(`Trace 操作失败：${String(error)}`, "error");
      }
      update(ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => update(ctx));
  pi.on("before_provider_request", (event, ctx) => {
    const trace = get();
    trace.capture(event.payload, {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: ctx.sessionManager.getSessionName() ?? "",
      cwd: ctx.cwd,
      provider: ctx.model?.provider ?? "unknown",
      model: ctx.model?.id ?? "unknown",
      api: ctx.model?.api ?? "unknown",
    });
    update(ctx);
    // undefined: inspect only; do not replace or mutate the provider payload.
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant")
      get().complete(ctx.sessionManager.getSessionId(), event.message);
    update(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await get().flush();
    update(ctx);
  });
  pi.on("session_shutdown", async () => {
    // No captured ctx/ui in asynchronous callbacks, including shutdown and reload.
    await controller?.close();
    controller = undefined;
  });
}
