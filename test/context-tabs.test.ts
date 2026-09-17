import assert from "node:assert/strict";
import { test } from "node:test";
import { contextItems, contextTabs } from "../web/context-tabs.ts";

test("messages are the first context tab; request categories and output have direct entries", () => {
  assert.deepEqual(
    contextTabs.map((tab) => tab.id),
    ["messages", "system", "tools", "settings", "response"],
  );
});

test("many tool definitions do not enter messages; order, paths and full fields survive", () => {
  const messages = [
    { role: "developer", content: "developer instructions" },
    { role: "user", content: "question", extra: "hidden metadata" },
    { role: "assistant", tool_calls: [{ id: "call-1", name: "read" }] },
    { role: "tool", tool_call_id: "call-1", content: "result" },
  ];
  const tools = Array.from({ length: 120 }, (_, index) => ({
    name: `tool_${index}`,
  }));
  const response = {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
  };
  const items = contextItems({
    payload: {
      instructions: "system instructions",
      messages,
      tools,
      temperature: 0.2,
    },
    response,
  });
  assert.deepEqual(
    items.messages.map((item) => item.value),
    messages.slice(1),
  );
  assert.deepEqual(
    items.messages.map((item) => item.path),
    ["messages[1]", "messages[2]", "messages[3]"],
  );
  assert.deepEqual(
    items.system.map((item) => item.path),
    ["instructions", "messages[0]"],
  );
  assert.deepEqual(
    items.tools.map((item) => item.value),
    tools,
  );
  assert.deepEqual(items.settings[0]?.value, { temperature: 0.2 });
  assert.equal(items.response[0]?.value, response);
  assert.equal(items.response[0]?.text, "answer");
});

test("absent categories stay empty and unknown fields remain accessible", () => {
  const empty = contextItems({
    payload: { messages: [], tools: [] },
    response: null,
  });
  for (const tab of contextTabs) assert.deepEqual(empty[tab.id], []);
  const unknown = contextItems({
    payload: { vendorOption: { keep: true } },
    response: null,
  });
  assert.deepEqual(unknown.settings[0]?.value, {
    vendorOption: { keep: true },
  });
});
