import { randomUUID } from "node:crypto";
import { startViewer, type ViewerServer, type ViewerStatus } from "./server.ts";
import { type CaptureMeta, TraceStore } from "./store.ts";

export class TraceController {
  private store: TraceStore | undefined;
  private viewer: ViewerServer | undefined;
  private work: Promise<void> = Promise.resolve();
  private inFlight = new Map<string, string>();
  private readonly path: string;
  readonly state: ViewerStatus = {
    enabled: false,
    sessionId: "",
    revision: 0,
    error: null,
    pending: 0,
  };
  constructor(path: string) {
    this.path = path;
  }
  get url(): string | undefined {
    return this.viewer?.url;
  }
  async open(): Promise<string> {
    if (!this.store) this.store = new TraceStore(this.path);
    if (!this.viewer)
      this.viewer = await startViewer(this.store, () => ({ ...this.state }));
    return this.viewer.url;
  }
  async enable(): Promise<string> {
    const url = await this.open();
    this.state.error = null;
    this.state.enabled = true;
    this.state.revision++;
    return url;
  }
  async disable(): Promise<void> {
    this.state.enabled = false;
    this.inFlight.clear();
    await this.work;
    this.state.revision++;
  }
  capture(payload: unknown, meta: Omit<CaptureMeta, "id" | "createdAt">): void {
    if (!this.state.enabled) return;
    try {
      // Serialize at the hook boundary so later mutations cannot alter this snapshot.
      const serialized = JSON.stringify(payload);
      if (serialized === undefined)
        throw new Error("provider payload 不是 JSON");
      const id = randomUUID();
      this.inFlight.set(meta.sessionId, id);
      this.queue((store) =>
        store.capture(
          { ...meta, id, createdAt: new Date().toISOString() },
          serialized,
        ),
      );
    } catch (error) {
      this.fail(error);
    }
  }
  complete(sessionId: string, message: unknown): void {
    if (!this.state.enabled) return;
    const id = this.inFlight.get(sessionId);
    if (!id) return;
    this.inFlight.delete(sessionId);
    try {
      const serialized = JSON.stringify(message);
      if (serialized !== undefined)
        this.queue((store) => store.complete(id, serialized));
    } catch (error) {
      this.fail(error);
    }
  }
  async flush(): Promise<void> {
    await this.work;
  }
  private queue(action: (store: TraceStore) => Promise<void>): void {
    const store = this.store;
    if (!store) return;
    this.state.pending++;
    this.work = this.work
      .then(() => action(store))
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.state.pending--;
        this.state.revision++;
      });
  }
  private fail(error: unknown): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.state.enabled = false;
    this.inFlight.clear();
    this.state.revision++;
  }
  async close(): Promise<void> {
    await this.disable();
    await this.viewer?.close();
    this.viewer = undefined;
    this.store?.close();
    this.store = undefined;
  }
}
