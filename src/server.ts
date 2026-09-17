import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { TraceStore } from "./store.ts";

export interface ViewerStatus {
  enabled: boolean;
  sessionId: string;
  revision: number;
  error: string | null;
  pending: number;
}
export interface ViewerServer {
  url: string;
  close(): Promise<void>;
}

export async function startViewer(
  store: TraceStore,
  status: () => ViewerStatus,
  preferredPort = 4318,
): Promise<ViewerServer> {
  let origin = "";
  const assets = new Map([
    [
      "/",
      [
        new URL("../web/index.html", import.meta.url),
        "text/html; charset=utf-8",
      ],
    ],
    [
      "/style.css",
      [new URL("../web/style.css", import.meta.url), "text/css; charset=utf-8"],
    ],
    [
      "/app.js",
      [
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../dist/web/app.js"
            : "./web/app.js",
          import.meta.url,
        ),
        "text/javascript; charset=utf-8",
      ],
    ],
  ] as const);
  const server = createServer((req, res) => {
    const reply = (code: number, data: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    // Loopback only, plus Host/Origin validation to reject DNS rebinding and remote pages.
    if (
      `http://${req.headers.host}` !== origin ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      reply(403, { error: "仅允许本地查看器访问" });
      return;
    }
    if (req.method !== "GET") {
      reply(405, { error: "只读接口" });
      return;
    }
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/api/status") return reply(200, status());
      if (url.pathname === "/api/sessions") return reply(200, store.sessions());
      if (url.pathname === "/api/requests") {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (!Number.isSafeInteger(offset) || offset < 0)
          return reply(400, { error: "无效的分页参数" });
        return reply(
          200,
          store.list(url.searchParams.get("session") ?? "", offset),
        );
      }
      const match = /^\/api\/requests\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (match?.[1]) {
        const detail = await store.detail(match[1]);
        return reply(detail ? 200 : 404, detail ?? { error: "请求不存在" });
      }
      const asset = assets.get(url.pathname as "/" | "/style.css" | "/app.js");
      if (!asset) return reply(404, { error: "不存在的页面" });
      const content = await readFile(fileURLToPath(asset[0]));
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(content);
    })().catch(() => {
      if (!res.headersSent)
        reply(500, { error: "读取失败，请检查 trace 状态或重新打开查看器" });
      else res.end();
    });
  });
  try {
    await listen(server, preferredPort);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EADDRINUSE"
    )
      throw error;
    await listen(server, 0);
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("无法获取本地查看器地址");
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    const failed = (error: unknown) => {
      server.off("error", failed);
      server.off("listening", ready);
      reject(error);
    };
    server.once("error", failed);
    try {
      server.listen(port, "127.0.0.1", ready);
    } catch (error) {
      failed(error);
    }
  });
}
