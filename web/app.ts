import {
  type ContextItem,
  compareMessages,
  equal,
  json,
  normalize,
  object,
} from "../src/payload.ts";
import type { ViewerStatus } from "../src/server.ts";
import type { RequestDetail, RequestSummary } from "../src/store.ts";
import { contextItems, contextTabs } from "./context-tabs.ts";
import { createJsonTree } from "./json-tree.ts";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function id<T extends HTMLElement = HTMLElement>(name: string): T {
  const found = document.getElementById(name);
  if (!found) throw new Error(`Missing element ${name}`);
  return found as T;
}
async function api<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`无法读取记录 (${response.status})`);
  return response.json() as Promise<T>;
}
interface Session {
  sessionId: string;
  count: number;
  name: string;
  updatedAt: string;
}
interface Page {
  results: RequestSummary[];
  total: number;
  nextOffset: number | null;
}
let sessions: Session[] = [];
let selectedSession = "";
let requests: RequestSummary[] = [];
let current: RequestDetail | null = null;
let previous: RequestDetail | null = null;
let nextOffset: number | null = null;
let total = 0;
const tabs = [
  ...contextTabs,
  { id: "diff", label: "与上次比较" },
  { id: "raw", label: "原始 JSON" },
] as const;
type Mode = (typeof tabs)[number]["id"];
let mode: Mode = "messages";
let items = contextItems({ payload: {}, response: null });
let following = true;
let revision = -1;
let loading = false;
let generation = 0;
let showUnchanged = false;
let rawTree: ReturnType<typeof createJsonTree> | null = null;
const expanded = new Map<string, boolean>();
const time = (date: string) =>
  new Date(date).toLocaleTimeString("zh-CN", { hour12: false });
const number = (value: number) => value.toLocaleString("zh-CN");
const size = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)} MB`
    : `${(value / 1000).toFixed(1)} KB`;
const error = (message: string | null) => {
  id("error").hidden = !message;
  id("error").textContent = message ?? "";
};
const query = () =>
  id<HTMLInputElement>("search").value.trim().toLocaleLowerCase();

function highlight(text: string, term: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!term) {
    fragment.append(text);
    return fragment;
  }
  const lower = text.toLocaleLowerCase();
  let from = 0;
  let count = 0;
  // Bound DOM node growth for very repetitive payloads; text remains fully readable.
  while (count++ < 2000) {
    const position = lower.indexOf(term, from);
    if (position < 0) break;
    fragment.append(text.slice(from, position));
    fragment.append(
      element("mark", "", text.slice(position, position + term.length)),
    );
    from = position + term.length;
  }
  fragment.append(text.slice(from));
  return fragment;
}
function matches(item: ContextItem): boolean {
  return (
    !query() ||
    `${item.path} ${item.role} ${json(item.value)}`
      .toLocaleLowerCase()
      .includes(query())
  );
}
function textBlock(text: string): HTMLPreElement {
  const block = element("pre", "card-text");
  block.append(highlight(text, query()));
  return block;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const node = element("button", "text-button", label);
  node.addEventListener("click", action);
  return node;
}
async function copy(text: string, target: HTMLButtonElement): Promise<void> {
  const label = target.textContent;
  try {
    await navigator.clipboard.writeText(text);
    target.textContent = "已复制";
  } catch {
    target.textContent = "复制失败，请导出 JSON";
  }
  setTimeout(() => {
    target.textContent = label;
  }, 1600);
}
function card(
  item: ContextItem,
  kind = "",
  forceOpen = false,
): HTMLDetailsElement {
  const node = element("details", `context-card ${kind}`);
  const key = `${kind}:${item.path}`;
  node.dataset.key = key;
  const summary = element("summary");
  summary.append(element("span", "chevron", "▸"));
  if (kind)
    summary.append(
      element("span", "change-mark", kind === "added" ? "+ 新增" : "− 移除"),
    );
  const roleClass = [
    "user",
    "assistant",
    "model",
    "system",
    "developer",
  ].includes(item.role)
    ? item.role
    : "tool";
  summary.append(element("span", `role role-${roleClass}`, item.role));
  const preview = element("span", "preview");
  preview.append(
    highlight(item.text.replace(/\s+/g, " ").slice(0, 200), query()),
  );
  summary.append(preview, element("span", "path", item.path));
  node.append(summary);
  let rendered = false;
  const renderBody = () => {
    if (rendered) return;
    rendered = true;
    const body = element("div", "card-body");
    const actions = element("div", "card-actions");
    const copyButton = button("复制此项", () => {
      void copy(json(item.value), copyButton);
    });
    actions.append(copyButton);
    body.append(actions, textBlock(item.text));
    if (item.text !== json(item.value)) {
      const original = element("details", "original");
      original.append(element("summary", "", "完整原始字段"));
      original.addEventListener("toggle", () => {
        if (original.open && original.childElementCount === 1)
          original.append(textBlock(json(item.value)));
      });
      body.append(original);
    }
    node.append(body);
  };
  node.open = Boolean(query()) || (expanded.get(key) ?? forceOpen);
  if (node.open) renderBody();
  node.addEventListener("toggle", () => {
    if (!node.isConnected) return;
    expanded.set(key, node.open);
    if (node.open) renderBody();
  });
  return node;
}
function section(
  container: HTMLElement,
  title: string,
  items: ContextItem[],
  defaultOpen = false,
): void {
  const filtered = items.filter(matches);
  if (!filtered.length) return;
  const heading = element("h2", "section-heading", title);
  heading.append(element("small", "", `${filtered.length} 项`));
  container.append(heading);
  for (const item of filtered) {
    container.append(card(item, "", defaultOpen && items.length === 1));
  }
}
function renderContext(tab: (typeof contextTabs)[number]): void {
  const container = id("content");
  section(container, tab.title, items[tab.id], tab.id === "response");
  if (!container.childElementCount)
    container.append(
      element(
        "p",
        "no-results",
        query()
          ? "此分类没有匹配内容，请查看标签上的匹配数量并切换分类。"
          : tab.empty,
      ),
    );
  id("view-note").textContent = query()
    ? `搜索各分类完整字段 · 标签显示匹配项 / 总项数 · “${query()}”`
    : tab.note;
}
function renderTabs(): void {
  for (const tab of tabs) {
    const node = id<HTMLButtonElement>(`tab-${tab.id}`);
    node.setAttribute("aria-selected", String(mode === tab.id));
    node.tabIndex = mode === tab.id ? 0 : -1;
  }
  for (const tab of contextTabs) {
    const count = items[tab.id].length;
    const matched = query() ? items[tab.id].filter(matches).length : count;
    const node = id(`tab-${tab.id}`);
    node.replaceChildren(document.createTextNode(tab.label));
    const badge = element(
      "span",
      "tab-count",
      query() ? `${matched}/${count}` : number(count),
    );
    badge.setAttribute("aria-hidden", "true");
    node.append(badge);
    node.setAttribute(
      "aria-label",
      query()
        ? `${tab.label}，${matched} 项匹配，共 ${count} 项`
        : `${tab.label}，${count} 项`,
    );
    node.title = query() ? `${matched} 项匹配 / ${count} 项` : `${count} 项`;
  }
  id("content").setAttribute("aria-labelledby", `tab-${mode}`);
}
function changedSection(
  container: HTMLElement,
  title: string,
  before: unknown,
  after: unknown,
): void {
  if (equal(before, after)) return;
  const heading = element("h2", "section-heading", title);
  container.append(heading);
  const pair = element("div", "diff-pair");
  for (const [label, value, kind] of [
    ["上次请求", before, "removed"],
    ["本次请求", after, "added"],
  ] as const) {
    const column = element("div", "diff-column");
    column.append(element("p", "", label));
    const item = { path: title, role: title, value, text: json(value) };
    if (matches(item)) column.append(card(item, kind, true));
    pair.append(column);
  }
  container.append(pair);
}
function renderDiff(detail: RequestDetail): void {
  const container = id("content");
  if (!previous) {
    container.append(
      element(
        "p",
        "no-results",
        "这是本会话捕获的第一条请求，没有更早的快照可比较。",
      ),
    );
    return;
  }
  const before = normalize(previous.payload);
  const after = normalize(detail.payload);
  const differences = compareMessages(before.messages, after.messages);
  const added = differences.filter((entry) => entry.kind === "added").length;
  const removed = differences.filter(
    (entry) => entry.kind === "removed",
  ).length;
  const unchanged = differences.length - added - removed;
  const intro = element(
    "div",
    "diff-intro",
    `#${previous.summary.seq} → #${detail.summary.seq} · `,
  );
  intro.append(
    element("strong", "", `${added} 条新增 · ${removed} 条移除`),
    document.createTextNode(` · ${unchanged} 条消息保持不变`),
  );
  const label = element("label", "diff-toggle");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.checked = showUnchanged;
  checkbox.addEventListener("change", () => {
    showUnchanged = checkbox.checked;
    renderContent();
  });
  label.append(checkbox, "显示未变化的消息");
  intro.append(label);
  container.append(intro);
  changedSection(
    container,
    "系统指令变化",
    before.system.map((item) => item.value),
    after.system.map((item) => item.value),
  );
  changedSection(
    container,
    "工具定义变化",
    before.tools.map((item) => item.value),
    after.tools.map((item) => item.value),
  );
  changedSection(container, "参数变化", before.settings, after.settings);
  container.append(element("h2", "section-heading", "消息变化"));
  const visible = differences.filter(
    (entry) =>
      (showUnchanged || entry.kind !== "unchanged") && matches(entry.item),
  );
  for (const entry of visible) {
    container.append(
      card(
        entry.item,
        entry.kind === "unchanged" ? "" : entry.kind,
        entry.kind !== "unchanged",
      ),
    );
  }
  if (!visible.length)
    container.append(element("p", "unchanged-note", "没有可显示的消息变化。"));
  id("view-note").textContent =
    "与同一会话的上一条捕获请求比较 · 修改显示为移除 + 新增";
}
function renderContent(): void {
  rawTree?.dispose();
  rawTree = null;
  id("content").replaceChildren();
  if (!current) return;
  renderTabs();
  id("view-note").textContent = "";
  const contextTab = contextTabs.find((tab) => tab.id === mode);
  if (contextTab) renderContext(contextTab);
  else if (mode === "diff") renderDiff(current);
  else {
    rawTree = createJsonTree(current.payload, { query: query(), highlight });
    id("content").append(rawTree.element);
    id("view-note").textContent =
      "点击箭头展开对象或数组 · ← → 收起 / 展开 · 搜索自动展开匹配项";
  }
}
function stat(label: string, value: string, unit = ""): HTMLElement {
  const node = element("div", "stat");
  const amount = element("div", "stat-value", value);
  if (unit) amount.append(element("small", "", unit));
  node.append(element("div", "stat-label", label), amount);
  return node;
}
function renderDetail(): void {
  id("empty").hidden = Boolean(current);
  id("detail").hidden = !current;
  if (!current) return;
  const { summary, payload, response } = current;
  items = contextItems(current);
  id("request-kicker").textContent =
    `REQUEST #${summary.seq} / ${summary.provider}`;
  id("request-title").textContent = summary.title;
  id("request-meta").textContent =
    `${new Date(summary.createdAt).toLocaleString("zh-CN", { hour12: false })} · ${summary.model} · ${normalize(payload).format}`;
  id("request-meta").title = `${summary.cwd}\n${summary.id}`;
  const stats = id("stats");
  stats.replaceChildren(
    stat("消息", number(summary.messageCount)),
    stat("可用工具", number(summary.toolCount)),
    stat("请求大小", size(summary.bytes)),
  );
  const usage = object(object(response).usage);
  if (typeof usage.input === "number")
    stats.append(
      stat(
        "输入 / 缓存读取",
        `${number(usage.input)} / ${number(Number(usage.cacheRead ?? 0))}`,
        "tok",
      ),
    );
  if (typeof usage.output === "number")
    stats.append(stat("输出", number(usage.output), "tok"));
  const view = normalize(payload);
  const groups = [
    ["系统指令", "system-color", view.system],
    ["消息", "message-color", view.messages],
    ["工具", "tool-color", view.tools],
  ].map(([label, color, items]) => ({
    label: String(label),
    color: String(color),
    length: (items as ContextItem[]).reduce(
      (sum, item) => sum + Array.from(JSON.stringify(item.value) ?? "").length,
      0,
    ),
  }));
  groups.push({
    label: "其他字段",
    color: "setting-color",
    length: Array.from(JSON.stringify(view.settings)).length,
  });
  const sum = groups.reduce((count, entry) => count + entry.length, 0);
  id("map-total").textContent =
    `${number(sum)} 字符 · 按内容体积，非 token 估算`;
  id("map-bar").replaceChildren();
  id("map-legend").replaceChildren();
  for (const group of groups) {
    if (group.length) {
      const segment = element("progress", `segment ${group.color}`);
      segment.max = sum;
      segment.value = group.length;
      // The flex basis is reflected by a numeric width attribute on an SVG-free native progress.
      segment.setAttribute(
        "aria-label",
        `${group.label} ${number(group.length)} 字符`,
      );
      segment.style.flexGrow = String(group.length);
      segment.style.flexBasis = "0";
      segment.value = sum;
      segment.title = `${group.label} ${number(group.length)} 字符`;
      id("map-bar").append(segment);
    }
    const legend = element(
      "span",
      "",
      `${group.label} ${sum ? Math.round((group.length / sum) * 100) : 0}%`,
    );
    legend.prepend(element("i", `legend-dot ${group.color}`));
    id("map-legend").append(legend);
  }
  renderContent();
}
function renderRequests(): void {
  const filter = id<HTMLInputElement>("request-filter")
    .value.trim()
    .toLocaleLowerCase();
  const visible = requests.filter((request) =>
    `${request.title} ${request.model} ${request.seq} ${request.createdAt}`
      .toLocaleLowerCase()
      .includes(filter),
  );
  id("requests").replaceChildren();
  for (const request of visible) {
    const node = element(
      "button",
      `request-row${current?.summary.id === request.id ? " selected" : ""}`,
    );
    node.setAttribute(
      "aria-current",
      String(current?.summary.id === request.id),
    );
    const top = element("div", "row-top");
    top.append(
      element("strong", "", `#${request.seq}`),
      element("span", "model", request.model),
    );
    const bottom = element("div", "row-bottom");
    bottom.append(
      element(
        "span",
        "",
        `${request.messageCount} 消息 · ${size(request.bytes)}`,
      ),
      element("time", "row-time", time(request.createdAt)),
    );
    node.append(top, element("div", "row-title", request.title), bottom);
    node.title = `${request.title}\n${request.createdAt}`;
    node.addEventListener("click", () => {
      setFollowing(false);
      void selectRequest(request.id).catch((e: unknown) => error(String(e)));
    });
    id("requests").append(node);
  }
  if (!visible.length)
    id("requests").append(
      element(
        "p",
        "no-results",
        requests.length ? "没有匹配的请求" : "等待下一次模型请求",
      ),
    );
  id("request-count").textContent =
    `${filter ? `${visible.length} 匹配 / ` : ""}${total} 条请求`;
  id("load-more").hidden = nextOffset === null;
}
function renderSessions(): void {
  const select = id<HTMLSelectElement>("sessions");
  select.replaceChildren();
  for (const session of sessions) {
    const node = element(
      "option",
      "",
      `${session.name || `会话 ${session.sessionId.slice(0, 8)}`} · ${session.count}`,
    );
    node.value = session.sessionId;
    select.append(node);
  }
  if (!sessions.length) select.append(element("option", "", "暂无已捕获会话"));
  select.value = selectedSession;
}
async function selectRequest(requestId: string): Promise<void> {
  const ticket = ++generation;
  const detail = await api<RequestDetail>(`/api/requests/${requestId}`);
  const before = detail.previousId
    ? await api<RequestDetail>(`/api/requests/${detail.previousId}`)
    : null;
  if (ticket !== generation) return;
  if (current?.summary.id !== requestId) expanded.clear();
  current = detail;
  previous = before;
  renderRequests();
  renderDetail();
}
async function refreshRequests(append = false): Promise<void> {
  const sessionId = selectedSession;
  if (!sessionId) {
    current = null;
    requests = [];
    total = 0;
    nextOffset = null;
    renderRequests();
    renderDetail();
    return;
  }
  const offset = append ? (nextOffset ?? 0) : 0;
  const page = await api<Page>(
    `/api/requests?session=${encodeURIComponent(sessionId)}&offset=${offset}`,
  );
  if (sessionId !== selectedSession) return;
  requests = append
    ? [
        ...requests,
        ...page.results.filter(
          (entry) => !requests.some((old) => old.id === entry.id),
        ),
      ]
    : page.results;
  nextOffset = page.nextOffset;
  total = page.total;
  const target =
    following || current?.summary.sessionId !== sessionId
      ? requests[0]?.id
      : current?.summary.id;
  if (target) {
    const changed =
      target !== current?.summary.id ||
      (!current.summary.hasResponse &&
        requests.some((entry) => entry.id === target && entry.hasResponse));
    if (changed) await selectRequest(target);
    else renderRequests();
  } else {
    current = null;
    previous = null;
    renderRequests();
    renderDetail();
  }
}
function setFollowing(value: boolean): void {
  following = value;
  id("follow").classList.toggle("active", value);
  id("follow").setAttribute("aria-pressed", String(value));
}
async function poll(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const status = await api<ViewerStatus>("/api/status");
    id("connection").textContent = status.enabled
      ? `监听中${status.pending ? " · 写入中" : ""}`
      : "监听已关闭 · 可浏览历史";
    id("connection").classList.toggle("live", status.enabled);
    error(status.error);
    if (revision !== status.revision) {
      sessions = await api<Session[]>("/api/sessions");
      if (
        !selectedSession ||
        !sessions.some((session) => session.sessionId === selectedSession)
      )
        selectedSession =
          sessions.find((session) => session.sessionId === status.sessionId)
            ?.sessionId ??
          sessions[0]?.sessionId ??
          "";
      renderSessions();
      await refreshRequests();
      revision = status.revision;
    }
  } catch {
    id("connection").textContent = "连接已断开";
    id("connection").classList.remove("live");
    error(
      "查看器连接已断开。若已退出或重载 Pi，请运行 /trace ui，并打开它给出的新地址。",
    );
  } finally {
    loading = false;
  }
}
id<HTMLSelectElement>("sessions").addEventListener("change", () => {
  selectedSession = id<HTMLSelectElement>("sessions").value;
  generation++;
  setFollowing(true);
  void refreshRequests().catch((e: unknown) => error(String(e)));
});
id("request-filter").addEventListener("input", renderRequests);
let searchTimer: ReturnType<typeof setTimeout>;
id("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderContent, 120);
});
id("follow").addEventListener("click", () => {
  setFollowing(!following);
  if (following) void refreshRequests().catch((e: unknown) => error(String(e)));
});
id("load-more").addEventListener("click", () => {
  void refreshRequests(true).catch((e: unknown) => error(String(e)));
});
function selectTab(tab: Mode): void {
  // Return to the panel's start only when the reader has scrolled into its content.
  const offset =
    id("content-controls").getBoundingClientRect().top -
    id("toolbar").getBoundingClientRect().bottom;
  if (offset < 0) window.scrollBy({ top: offset - 14 });
  mode = tab;
  renderContent();
}
for (const tab of tabs) {
  const node = element("button", "", tab.label);
  node.type = "button";
  node.id = `tab-${tab.id}`;
  node.setAttribute("role", "tab");
  node.setAttribute("aria-controls", "content");
  node.addEventListener("click", () => selectTab(tab.id));
  id("tabs").append(node);
}
id("tabs").addEventListener("keydown", (event) => {
  const index = tabs.findIndex((tab) => tab.id === mode);
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (index + 1) % tabs.length;
      break;
    case "ArrowLeft":
      next = (index + tabs.length - 1) % tabs.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const tab = tabs[next];
  if (!tab) return;
  selectTab(tab.id);
  const node = id(`tab-${tab.id}`);
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
});
id("expand-all").addEventListener("click", () => {
  if (rawTree) {
    void rawTree.setExpanded(true);
    return;
  }
  for (const item of document.querySelectorAll<HTMLDetailsElement>(
    ".context-card",
  )) {
    expanded.set(item.dataset.key ?? "", true);
    item.open = true;
  }
});
id("collapse-all").addEventListener("click", () => {
  if (rawTree) {
    void rawTree.setExpanded(false);
    return;
  }
  for (const item of document.querySelectorAll<HTMLDetailsElement>(
    ".context-card",
  )) {
    expanded.set(item.dataset.key ?? "", false);
    item.open = false;
  }
});
id<HTMLButtonElement>("copy").addEventListener("click", () => {
  if (current) void copy(json(current.payload), id("copy"));
});
id("download").addEventListener("click", () => {
  if (!current) return;
  const link = element("a");
  const url = URL.createObjectURL(
    new Blob([json(current.payload)], { type: "application/json" }),
  );
  link.href = url;
  link.download = `pi-context-${current.summary.seq}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function theme(value: string): void {
  document.documentElement.dataset.theme = value;
}
try {
  theme(
    localStorage.getItem("pi-context-trace-theme") ??
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
} catch {
  theme("light");
}
id("theme").addEventListener("click", () => {
  const value =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  theme(value);
  try {
    localStorage.setItem("pi-context-trace-theme", value);
  } catch {
    /* Theme still works when storage is unavailable. */
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement ||
    (event.target instanceof HTMLElement &&
      Boolean(event.target.closest(".json-tree, [role=tablist]"))) ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  const direction =
    event.key === "ArrowDown" || event.key === "j"
      ? 1
      : event.key === "ArrowUp" || event.key === "k"
        ? -1
        : 0;
  if (!direction) return;
  const visible = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".request-row"),
  );
  const index = visible.findIndex(
    (node) => node.getAttribute("aria-current") === "true",
  );
  const target = visible[index + direction];
  if (target) {
    event.preventDefault();
    target.click();
    target.scrollIntoView({ block: "nearest" });
  }
});
void poll();
setInterval(() => {
  if (!document.hidden) void poll();
}, 1800);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void poll();
});
