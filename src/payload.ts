export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readable).join("\n\n");
  const item = object(value);
  if (typeof item.text === "string") return item.text;
  // Non-text blocks keep all their fields; the original payload is never truncated.
  return json(value);
}

export interface ContextItem {
  path: string;
  role: string;
  text: string;
  value: unknown;
}

interface ContextView {
  system: ContextItem[];
  messages: ContextItem[];
  tools: ContextItem[];
  settings: Record<string, unknown>;
  format: string;
}

export function normalize(payload: unknown): ContextView {
  const body = object(payload);
  const view: ContextView = {
    system: [],
    messages: [],
    tools: [],
    settings: {},
    format: "通用 JSON",
  };
  const used = new Set<string>();
  for (const key of ["system", "instructions", "systemInstruction"]) {
    if (body[key] !== undefined) {
      used.add(key);
      const value = body[key];
      view.system.push({
        path: key,
        role: "system",
        value,
        text: readable(object(value).parts ?? value),
      });
    }
  }
  const messageKey = ["messages", "input", "contents"].find(
    (key) => body[key] !== undefined,
  );
  if (messageKey) {
    used.add(messageKey);
    view.format =
      messageKey === "input"
        ? "OpenAI Responses"
        : messageKey === "contents"
          ? "Gemini"
          : body.system !== undefined
            ? "Anthropic Messages"
            : "Chat Completions";
    const source = body[messageKey];
    const messages = Array.isArray(source) ? source : [source];
    messages.forEach((value, index) => {
      const item = object(value);
      const role = String(item.role ?? item.type ?? "user");
      const text = readable(item.content ?? item.parts ?? value);
      const entry = { path: `${messageKey}[${index}]`, role, value, text };
      if (role === "system" || role === "developer") view.system.push(entry);
      else view.messages.push(entry);
    });
  }
  if (Array.isArray(body.tools)) {
    used.add("tools");
    body.tools.forEach((value, index) => {
      const item = object(value);
      const fn = object(item.function);
      view.tools.push({
        path: `tools[${index}]`,
        role: String(item.name ?? fn.name ?? "tool"),
        value,
        text: json(value),
      });
    });
  }
  for (const [key, value] of Object.entries(body))
    if (!used.has(key)) view.settings[key] = value;
  if (Object.keys(body).length === 0) view.settings.payload = payload;
  return view;
}

export function payloadTitle(view: ContextView): string {
  const last = view.messages.findLast((message) => message.role === "user");
  return (last?.text ?? view.messages.at(-1)?.text ?? "上下文快照")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface Difference {
  kind: "added" | "removed" | "unchanged";
  item: ContextItem;
}

/** Ordered LCS preserves insertions/removals. Large middles are shown as removed/added,
 * never falsely paired by array index; bound the comparison matrix to 4 MB. */
export function compareMessages(
  before: ContextItem[],
  after: ContextItem[],
): Difference[] {
  const a = before.map((item) => canonical(item.value));
  const b = after.map((item) => canonical(item.value));
  const result: Difference[] = [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    result.push({ kind: "unchanged", item: after[prefix] as ContextItem });
    prefix++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const width = endB - prefix + 1;
  const height = endA - prefix + 1;
  const cells = width * height;
  const matrix = cells <= 1_000_000 ? new Uint32Array(cells) : null;
  if (matrix) {
    for (let i = height - 2; i >= 0; i--)
      for (let j = width - 2; j >= 0; j--) {
        matrix[i * width + j] =
          a[prefix + i] === b[prefix + j]
            ? 1 + (matrix[(i + 1) * width + j + 1] ?? 0)
            : Math.max(
                matrix[(i + 1) * width + j] ?? 0,
                matrix[i * width + j + 1] ?? 0,
              );
      }
  }
  let i = prefix;
  let j = prefix;
  while (i < endA || j < endB) {
    if (matrix && i < endA && j < endB && a[i] === b[j]) {
      result.push({ kind: "unchanged", item: after[j++] as ContextItem });
      i++;
    } else if (
      i < endA &&
      (!matrix ||
        j >= endB ||
        (matrix[(i - prefix + 1) * width + j - prefix] ?? 0) >=
          (matrix[(i - prefix) * width + j - prefix + 1] ?? 0))
    ) {
      result.push({ kind: "removed", item: before[i++] as ContextItem });
    } else result.push({ kind: "added", item: after[j++] as ContextItem });
  }
  while (endB < after.length)
    result.push({ kind: "unchanged", item: after[endB++] as ContextItem });
  return result;
}

export function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
