import { db } from "./index";

// One row per contractor whose ServiceTitan tenant is being archived.
export interface Client {
  id: number;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  cutoverDate: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
}

interface ClientRow {
  id: number;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  cutover_date: string | null;
  notes: string | null;
  archived: number;
  created_at: string;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    cutoverDate: row.cutover_date,
    notes: row.notes,
    archived: row.archived === 1,
    createdAt: row.created_at,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO clients (name, contact_name, contact_email, cutover_date, notes)
  VALUES (@name, @contactName, @contactEmail, @cutoverDate, @notes)
`);
const getStmt = db.prepare(`SELECT * FROM clients WHERE id = ?`);
const listStmt = db.prepare(`SELECT * FROM clients ORDER BY archived, name`);
const updateStmt = db.prepare(`
  UPDATE clients SET name = @name, contact_name = @contactName, contact_email = @contactEmail,
    cutover_date = @cutoverDate, notes = @notes, archived = @archived
  WHERE id = @id
`);
const deleteStmt = db.prepare(`DELETE FROM clients WHERE id = ?`);

export interface ClientInput {
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  cutoverDate?: string | null;
  notes?: string | null;
}

export function createClient(input: ClientInput): Client {
  const info = insertStmt.run({
    name: input.name,
    contactName: input.contactName ?? null,
    contactEmail: input.contactEmail ?? null,
    cutoverDate: input.cutoverDate ?? null,
    notes: input.notes ?? null,
  });
  return getClient(Number(info.lastInsertRowid))!;
}

export function getClient(id: number): Client | undefined {
  const row = getStmt.get(id) as unknown as ClientRow | undefined;
  return row ? toClient(row) : undefined;
}

export function listClients(): Client[] {
  return (listStmt.all() as unknown as ClientRow[]).map(toClient);
}

export function updateClient(id: number, input: ClientInput & { archived?: boolean }): void {
  const existing = getClient(id);
  if (!existing) return;
  updateStmt.run({
    id,
    name: input.name,
    contactName: input.contactName ?? null,
    contactEmail: input.contactEmail ?? null,
    cutoverDate: input.cutoverDate ?? null,
    notes: input.notes ?? null,
    archived: (input.archived ?? existing.archived) ? 1 : 0,
  });
}

// Cascades to client_settings and (through runs) to run_files, so deleting a
// client leaves no orphaned credentials behind. The zips on disk are removed
// by the caller first — the filesystem has no foreign keys.
export function deleteClient(id: number): void {
  deleteStmt.run(id);
}
