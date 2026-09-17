interface TreeOptions {
  query: string;
  highlight(text: string, query: string): DocumentFragment;
}
interface Branch {
  node: HTMLDetailsElement;
  reveal(): boolean;
}
interface JsonTree {
  element: HTMLElement;
  setExpanded(expanded: boolean): Promise<void>;
  dispose(): void;
}
const pageSize = 100;

/** Native disclosure controls, with children created only when a branch is opened. */
export function createJsonTree(value: unknown, options: TreeOptions): JsonTree {
  const root = document.createElement("div");
  root.className = "json-tree";
  const status = document.createElement("div");
  status.className = "json-tree-status";
  status.setAttribute("role", "status");
  root.append(status);
  const branches: Branch[] = [];
  let operation = 0;
  let disposed = false;
  const matches = new WeakMap<object, boolean>();

  function contains(entry: unknown): boolean {
    if (!options.query) return false;
    if (entry !== null && typeof entry === "object") {
      const cached = matches.get(entry);
      if (cached !== undefined) return cached;
      let found = false;
      // Visit all children once, retaining results for auto-expansion below.
      for (const [key, child] of Object.entries(entry)) {
        const childMatch = contains(child);
        if (key.toLocaleLowerCase().includes(options.query) || childMatch)
          found = true;
      }
      matches.set(entry, found);
      return found;
    }
    return (JSON.stringify(entry) ?? String(entry))
      .toLocaleLowerCase()
      .includes(options.query);
  }
  contains(value);

  function span(className: string, text: string): HTMLSpanElement {
    const result = document.createElement("span");
    result.className = className;
    result.append(options.highlight(text, options.query));
    return result;
  }
  function label(
    row: HTMLElement,
    key: string | null,
    arrayItem: boolean,
  ): void {
    if (key === null) return;
    row.append(
      span(
        arrayItem ? "json-index" : "json-key",
        arrayItem ? key : JSON.stringify(key),
      ),
      span("json-punctuation", ": "),
    );
  }
  function primitive(
    entry: unknown,
    key: string | null,
    arrayItem: boolean,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "json-line";
    row.tabIndex = 0;
    label(row, key, arrayItem);
    const text = JSON.stringify(entry) ?? String(entry);
    const kind = entry === null ? "null" : typeof entry;
    const rendered = span(
      `json-${kind}`,
      text.length > 500 && !options.query ? `${text.slice(0, 300)}…` : text,
    );
    row.append(rendered);
    if (text.length > 500 && !options.query) {
      let expanded = false;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "json-string-toggle";
      toggle.textContent = `展开字符串 (${text.length.toLocaleString()} 字符)`;
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        rendered.replaceChildren(
          options.highlight(
            expanded ? text : `${text.slice(0, 300)}…`,
            options.query,
          ),
        );
        toggle.textContent = expanded
          ? "收起字符串"
          : `展开字符串 (${text.length.toLocaleString()} 字符)`;
        toggle.setAttribute("aria-expanded", String(expanded));
      });
      row.append(toggle);
    }
    return row;
  }
  function node(
    entry: unknown,
    key: string | null,
    arrayItem = false,
    top = false,
  ): HTMLElement {
    if (entry === null || typeof entry !== "object")
      return primitive(entry, key, arrayItem);
    const entries = Object.entries(entry);
    const array = Array.isArray(entry);
    if (!entries.length) {
      const row = document.createElement("div");
      row.className = "json-line";
      row.tabIndex = 0;
      label(row, key, arrayItem);
      row.append(span("json-punctuation", array ? "[]" : "{}"));
      return row;
    }
    const details = document.createElement("details");
    details.className = "json-branch";
    const summary = document.createElement("summary");
    label(summary, key, arrayItem);
    summary.append(span("json-punctuation", array ? "[" : "{"));
    summary.append(
      span(
        "json-preview",
        ` ${entries.length.toLocaleString()} ${array ? "items" : "properties"} `,
      ),
    );
    summary.append(
      span("json-punctuation json-closing-preview", array ? "]" : "}"),
    );
    details.append(summary);
    const children = document.createElement("div");
    children.className = "json-children";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "json-more";
    let cursor = 0;
    const reveal = (): boolean => {
      const end = Math.min(cursor + pageSize, entries.length);
      while (cursor < end) {
        const pair = entries[cursor++];
        if (pair)
          children.insertBefore(
            node(pair[1], pair[0], array),
            more.parentNode ? more : null,
          );
      }
      const remaining = entries.length - cursor;
      more.textContent = `显示后 ${Math.min(remaining, pageSize)} 项 · 剩余 ${remaining.toLocaleString()} 项`;
      if (remaining > 0) children.append(more);
      else more.remove();
      return remaining > 0;
    };
    more.addEventListener("click", () => {
      reveal();
    });
    details.append(
      children,
      span("json-punctuation json-closing", array ? "]" : "}"),
    );
    branches.push({ node: details, reveal });
    details.addEventListener("toggle", () => {
      if (details.open && cursor === 0) reveal();
    });
    details.open =
      top ||
      contains(entry) ||
      (key !== null &&
        Boolean(options.query) &&
        key.toLocaleLowerCase().includes(options.query));
    if (details.open) {
      reveal();
      // Search must reveal matches beyond the first page as well.
      if (options.query) while (cursor < entries.length) reveal();
    }
    return details;
  }
  root.append(node(value, null, false, true));
  root.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const summary = event.target.closest("summary");
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowRight") details.open = true;
      else if (details.open) details.open = false;
      else
        details.parentElement
          ?.closest("details")
          ?.querySelector("summary")
          ?.focus();
    }
  });
  return {
    element: root,
    async setExpanded(expanded) {
      const ticket = ++operation;
      if (!expanded) {
        for (const branch of branches) branch.node.open = false;
        status.textContent = "";
        root.removeAttribute("aria-busy");
        return;
      }
      status.textContent = "正在展开…";
      root.setAttribute("aria-busy", "true");
      for (let index = 0; index < branches.length; index++) {
        const branch = branches[index];
        if (!branch || disposed || ticket !== operation) return;
        branch.node.open = true;
        let more = true;
        while (more) {
          more = branch.reveal();
          // Yield for large objects and allow collapse/disposal to cancel the work.
          if (more || index % 100 === 99) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            if (disposed || ticket !== operation) return;
          }
        }
      }
      status.textContent = "";
      root.removeAttribute("aria-busy");
    },
    dispose() {
      disposed = true;
      operation++;
    },
  };
}
