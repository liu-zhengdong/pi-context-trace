import {
  type ContextItem,
  json,
  normalize,
  object,
  readable,
} from "../src/payload.ts";
import type { RequestDetail } from "../src/store.ts";

export const contextTabs = [
  {
    id: "messages",
    label: "消息",
    title: "消息 · 按请求中的顺序",
    empty: "本次请求没有消息。",
    note: "保留请求中的消息顺序 · 点击卡片展开原文",
  },
  {
    id: "system",
    label: "系统指令",
    title: "系统指令",
    empty: "本次请求没有单独的系统指令。",
    note: "系统与 developer 指令 · 路径对应原始 payload",
  },
  {
    id: "tools",
    label: "工具",
    title: "工具定义",
    empty: "本次请求没有工具定义。",
    note: "本次请求提供的工具定义 · 工具调用与结果请查看消息",
  },
  {
    id: "settings",
    label: "生成参数",
    title: "生成参数与其他字段",
    empty: "本次请求没有生成参数或其他字段。",
    note: "生成参数与未归入其他分类的原始字段",
  },
  {
    id: "response",
    label: "本次输出",
    title: "本次输出 · Pi message_end",
    empty: "尚未记录本次输出；请求可能仍在进行，或捕获期间未收到 message_end。",
    note: "来自 Pi message_end 的逻辑输出 · 不属于请求 payload，也不是原始响应流",
  },
] as const;

type ContextTab = (typeof contextTabs)[number]["id"];

export function contextItems(
  detail: Pick<RequestDetail, "payload" | "response">,
): Record<ContextTab, ContextItem[]> {
  const view = normalize(detail.payload);
  return {
    messages: view.messages,
    system: view.system,
    tools: view.tools,
    settings: Object.keys(view.settings).length
      ? [
          {
            path: "settings",
            role: "parameters",
            value: view.settings,
            text: json(view.settings),
          },
        ]
      : [],
    response:
      detail.response === null
        ? []
        : [
            {
              path: "response",
              role: "assistant",
              value: detail.response,
              text: readable(
                object(detail.response).content ?? detail.response,
              ),
            },
          ],
  };
}
