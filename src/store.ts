import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { normalize, payloadTitle } from "./payload.ts";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export interface CaptureMeta {
  id: string;
  sessionId: string;
  sessionName: string;
  cwd: string;
  provider: string;
  model: string;
  api: string;
  createdAt: string;
}
export interface RequestSummary extends CaptureMeta {
  seq: number;
  title: string;
  bytes: number;
  messageCount: number;
  toolCount: number;
  hasResponse: boolean;
}
export interface RequestDetail {
  summary: RequestSummary;
  payload: unknown;
  response: unknown;
  previousId: string | null;
}

export class TraceStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        sessionId TEXT NOT NULL, sessionName TEXT NOT NULL, cwd TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL, createdAt TEXT NOT NULL,
        title TEXT NOT NULL, bytes INTEGER NOT NULL, messageCount INTEGER NOT NULL, toolCount INTEGER NOT NULL,
        payload BLOB NOT NULL, response BLOB
      );
      CREATE INDEX IF NOT EXISTS requests_session ON requests(sessionId,seq);`);
  }
  async capture(meta: CaptureMeta, serialized: string): Promise<void> {
    const view = normalize(JSON.parse(serialized));
    const data = await compress(serialized);
    this.db
      .prepare(`INSERT INTO requests (id,sessionId,sessionName,cwd,provider,model,api,createdAt,title,bytes,messageCount,toolCount,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        meta.id,
        meta.sessionId,
        meta.sessionName,
        meta.cwd,
        meta.provider,
        meta.model,
        meta.api,
        meta.createdAt,
        payloadTitle(view),
        Buffer.byteLength(serialized),
        view.messages.length,
        view.tools.length,
        data,
      );
  }
  async complete(id: string, serialized: string): Promise<void> {
    this.db
      .prepare("UPDATE requests SET response=? WHERE id=?")
      .run(await compress(serialized), id);
  }
  sessions() {
    return this.db
      .prepare(`SELECT sessionId, MAX(seq) AS latest, COUNT(*) AS count,
      (SELECT sessionName FROM requests r2 WHERE r2.sessionId=requests.sessionId ORDER BY seq DESC LIMIT 1) AS name,
      MAX(createdAt) AS updatedAt FROM requests GROUP BY sessionId ORDER BY latest DESC`)
      .all();
  }
  list(sessionId: string, offset = 0) {
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM requests WHERE sessionId=? ORDER BY seq DESC LIMIT 100 OFFSET ?`,
      )
      .all(sessionId, offset);
    const count = Number(
      this.db
        .prepare("SELECT COUNT(*) AS total FROM requests WHERE sessionId=?")
        .get(sessionId)?.total ?? 0,
    );
    return {
      results: rows.map(summary),
      total: count,
      nextOffset: offset + rows.length < count ? offset + rows.length : null,
    };
  }
  async detail(id: string): Promise<RequestDetail | null> {
    const row = this.db
      .prepare(`SELECT ${columns},payload,response FROM requests WHERE id=?`)
      .get(id);
    if (!row || !(row.payload instanceof Uint8Array)) return null;
    const previous = this.db
      .prepare(
        "SELECT id FROM requests WHERE sessionId=? AND seq<? ORDER BY seq DESC LIMIT 1",
      )
      .get(String(row.sessionId), Number(row.seq));
    return {
      summary: summary(row),
      payload: JSON.parse((await decompress(row.payload)).toString()),
      response:
        row.response instanceof Uint8Array
          ? JSON.parse((await decompress(row.response)).toString())
          : null,
      previousId: typeof previous?.id === "string" ? previous.id : null,
    };
  }
  close(): void {
    this.db.close();
  }
}
const columns =
  "seq,id,sessionId,sessionName,cwd,provider,model,api,createdAt,title,bytes,messageCount,toolCount,response IS NOT NULL AS hasResponse";
function summary(row: Record<string, unknown>): RequestSummary {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    sessionId: String(row.sessionId),
    sessionName: String(row.sessionName),
    cwd: String(row.cwd),
    provider: String(row.provider),
    model: String(row.model),
    api: String(row.api),
    createdAt: String(row.createdAt),
    title: String(row.title),
    bytes: Number(row.bytes),
    messageCount: Number(row.messageCount),
    toolCount: Number(row.toolCount),
    hasResponse: Boolean(row.hasResponse),
  };
}
