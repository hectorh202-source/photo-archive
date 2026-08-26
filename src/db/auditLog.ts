import { db } from "./index";

// An archive copies a contractor's customer records out of their CRM. Who
// did that, to whom, and when should never be a question without an answer.
export interface AuditEntry {
  clientId: number | null;
  userId: number | null;
  userEmail: string;
  action: string;
  target?: string | null;
  details?: Record<string, string | number | null>;
}

const insertStmt = db.prepare(`
  INSERT INTO audit_log (client_id, user_id, user_email, action, target, details_json)
  VALUES (@clientId, @userId, @userEmail, @action, @target, @detailsJson)
`);

export function logAudit(entry: AuditEntry): void {
  insertStmt.run({
    clientId: entry.clientId,
    userId: entry.userId,
    userEmail: entry.userEmail,
    action: entry.action,
    target: entry.target ?? null,
    detailsJson: entry.details ? JSON.stringify(entry.details) : null,
  });
}

const listStmt = db.prepare(`
  SELECT * FROM audit_log
  WHERE (@clientId IS NULL OR client_id = @clientId)
  ORDER BY created_at DESC, id DESC
  LIMIT @limit
`);

export interface AuditRow {
  id: number;
  client_id: number | null;
  user_email: string;
  action: string;
  target: string | null;
  details_json: string | null;
  created_at: string;
}

export function listAudit(clientId: number | null, limit = 200): AuditRow[] {
  return listStmt.all({ clientId, limit }) as unknown as AuditRow[];
}
