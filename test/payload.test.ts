import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMessages, equal, normalize } from "../src/payload.ts";

test("normalizes Responses without losing custom, reasoning, tool and image fields", () => {
  const payload = {
    instructions: "system",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "data:image/png;base64,fixture" },
        ],
      },
      { type: "function_call", name: "read", arguments: '{"path":"file"}' },
      { type: "function_call_output", call_id: "c", output: "evidence" },
      { type: "reasoning", encrypted_content: "opaque" },
    ],
    tools: [{ name: "read", parameters: { type: "object" } }],
    custom: { preserve: true },
  };
  const original = structuredClone(payload);
  const view = normalize(payload);
  assert.equal(view.format, "OpenAI Responses");
  assert.equal(view.system[0]?.text, "system");
  assert.equal(view.messages.length, 4);
  assert.match(view.messages[0]?.text ?? "", /image_url/);
  assert.equal(view.messages[3]?.value, payload.input[3]);
  assert.equal(view.tools[0]?.role, "read");
  assert.deepEqual(view.settings.custom, { preserve: true });
  assert.deepEqual(payload, original);
});
test("normalizes Anthropic, Chat Completions and Gemini system/message/tool structures", () => {
  const anthropic = normalize({
    system: [{ type: "text", text: "rules" }],
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "bash" }],
  });
  assert.equal(anthropic.system[0]?.text, "rules");
  assert.equal(anthropic.format, "Anthropic Messages");
  const chat = normalize({
    messages: [
      { role: "developer", content: "rules" },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "read" } }],
  });
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.system[0]?.path, "messages[0]");
  assert.equal(chat.tools[0]?.role, "read");
  const gemini = normalize({
    systemInstruction: { parts: [{ text: "rules" }] },
    contents: [{ role: "model", parts: [{ text: "answer" }] }],
    tools: [{ functionDeclarations: [{ name: "read" }] }],
  });
  assert.equal(gemini.system[0]?.text, "rules");
  assert.equal(gemini.messages[0]?.text, "answer");
});
const messages = (texts: string[]) =>
  normalize({ input: texts.map((text) => ({ role: "user", content: text })) })
    .messages;
test("diff handles insertions, removals, repeated messages and reordered object keys", () => {
  const diff = compareMessages(
    messages(["a", "b", "c"]),
    messages(["a", "new", "b", "c"]),
  );
  assert.deepEqual(
    diff.map((entry) => entry.kind),
    ["unchanged", "added", "unchanged", "unchanged"],
  );
  assert.deepEqual(
    compareMessages(messages(["a", "a", "b"]), messages(["a", "b"])).map(
      (entry) => entry.kind,
    ),
    ["unchanged", "removed", "unchanged"],
  );
  assert.equal(equal({ b: 1, a: 2 }, { a: 2, b: 1 }), true);
  assert.equal(equal([1, 2], [2, 1]), false);
});
test("diff shows collapsed context as removals and a new overview", () => {
  const diff = compareMessages(
    messages(["review", "full answer", "next"]),
    messages(["Experience summary", "next"]),
  );
  assert.equal(diff.filter((entry) => entry.kind === "removed").length, 2);
  assert.equal(diff.filter((entry) => entry.kind === "added").length, 1);
  assert.equal(diff.at(-1)?.kind, "unchanged");
});
test("large diff bounds memory and preserves every original item", () => {
  const before = messages(
    Array.from({ length: 1100 }, (_, i) => `before-${i}`),
  );
  const after = messages(Array.from({ length: 1100 }, (_, i) => `after-${i}`));
  const diff = compareMessages(before, after);
  assert.equal(diff.length, 2200);
  assert.equal(diff.filter((entry) => entry.kind === "added").length, 1100);
});
