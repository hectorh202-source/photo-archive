import session from "express-session";
import { db } from "../db/index";

const getStmt = db.prepare(`SELECT session_json FROM sessions WHERE sid = ? AND expires_at > ?`);
const setStmt = db.prepare(`
  INSERT INTO sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at
`);
const destroyStmt = db.prepare(`DELETE FROM sessions WHERE sid = ?`);
const pruneStmt = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SqliteSessionStore extends session.Store {
  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
    try {
      pruneStmt.run(Date.now());
      const row = getStmt.get(sid, Date.now()) as { session_json: string } | undefined;
      callback(null, row ? JSON.parse(row.session_json) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? DEFAULT_MAX_AGE_MS;
      setStmt.run(sid, JSON.stringify(sessionData), Date.now() + maxAge);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      destroyStmt.run(sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }
}
