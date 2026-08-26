import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Client, type SettingsPayload } from "../api";

// Everything this app needs to do its job for one client, in one place:
// the tenant it reads from, how hard it is allowed to read, what the output
// is called, and where it goes. Secrets are write-only — the server sends
// back whether one is set, never the value.

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  type?: "text" | "password" | "number" | "select" | "textarea";
  options?: { value: string; label: string }[];
  placeholder?: string;
}

interface SectionDef {
  title: string;
  note?: string;
  fields: FieldDef[];
}

const SECTIONS: SectionDef[] = [
  {
    title: "ServiceTitan",
    note: "The tenant photos are read from. Read-only throughout — nothing here can create, change, or delete anything in ServiceTitan.",
    fields: [
      {
        key: "st.environment",
        label: "Environment",
        type: "select",
        options: [
          { value: "production", label: "Production (real data)" },
          { value: "integration", label: "Integration (sandbox)" },
        ],
        hint: "Sandbox has its own separate fake data — real job numbers do not exist there.",
      },
      { key: "st.tenantId", label: "Tenant ID", placeholder: "1234567890" },
      { key: "st.clientId", label: "Client ID" },
      { key: "st.clientSecret", label: "Client Secret", type: "password", hint: "Stored encrypted; never sent back to this page." },
      { key: "st.appKey", label: "App Key" },
    ],
  },
  {
    title: "Pace and limits",
    note: "While the contractor is still running their business on ServiceTitan, a dispatcher waiting on a customer lookup matters more than an archive finishing sooner.",
    fields: [
      {
        key: "run.requestsPerSecond",
        label: "Requests per second",
        type: "number",
        hint: "5 is gentle and safe. Above 10 you are competing with their technicians.",
      },
      { key: "run.maxRetries", label: "Retries per request", type: "number", hint: "Applies to rate limits and server errors." },
      { key: "run.maxFileMb", label: "Max file size (MB)", type: "number", hint: "Anything larger is logged and skipped." },
      { key: "run.maxRunGb", label: "Max archive size (GB)", type: "number", hint: "The ceiling before a run stops adding files." },
    ],
  },
  {
    title: "Output",
    note: "Tokens: {customer} {date} {jobNumber} {n}",
    fields: [
      {
        key: "run.contents",
        label: "Include",
        type: "select",
        options: [
          { value: "photos", label: "Photos only" },
          { value: "attachments", label: "All attachments (photos + PDFs)" },
        ],
      },
      { key: "run.photoNameTemplate", label: "Photo filename", placeholder: "{customer} - {date} - {n}" },
      { key: "run.jobFolderTemplate", label: "Job folder name", placeholder: "{jobNumber} - {customer} - {date}" },
      {
        key: "run.includeManifest",
        label: "Manifest",
        type: "select",
        options: [
          { value: "1", label: "Include a manifest in every zip" },
          { value: "0", label: "Omit the manifest" },
        ],
        hint: "The manifest is the only record of a file that failed to download. Omitting it makes a gap invisible.",
      },
    ],
  },
  {
    title: "Delivery",
    note: "Download is the only target wired up today: archives are built here and handed over by hand. The cloud fields exist so their credentials have an encrypted home when each is implemented.",
    fields: [
      {
        key: "delivery.target",
        label: "Deliver by",
        type: "select",
        options: [
          { value: "download", label: "Download from this server" },
          { value: "googleDrive", label: "Google Drive (not implemented yet)" },
          { value: "dropbox", label: "Dropbox (not implemented yet)" },
          { value: "sharepoint", label: "SharePoint / OneDrive (not implemented yet)" },
          { value: "s3", label: "S3 or Backblaze B2 (not implemented yet)" },
        ],
      },
      { key: "delivery.googleDrive.folderId", label: "Google Drive folder ID" },
      { key: "delivery.googleDrive.refreshToken", label: "Google Drive refresh token", type: "password" },
      { key: "delivery.dropbox.path", label: "Dropbox path", placeholder: "/Job photos" },
      { key: "delivery.dropbox.refreshToken", label: "Dropbox refresh token", type: "password" },
      { key: "delivery.sharepoint.driveId", label: "SharePoint drive ID" },
      { key: "delivery.sharepoint.folderPath", label: "SharePoint folder path" },
      { key: "delivery.s3.bucket", label: "S3 bucket" },
      { key: "delivery.s3.region", label: "S3 region" },
      { key: "delivery.s3.endpoint", label: "S3 endpoint", placeholder: "https://s3.us-west-001.backblazeb2.com" },
      { key: "delivery.s3.accessKeyId", label: "S3 access key ID" },
      { key: "delivery.s3.secretAccessKey", label: "S3 secret access key", type: "password" },
    ],
  },
  {
    title: "Notifications",
    note: "A run takes days. These are how you find out it finished without watching the page.",
    fields: [
      { key: "notify.emailTo", label: "Email results to", placeholder: "you@example.com" },
      { key: "notify.smtpHost", label: "SMTP host" },
      { key: "notify.smtpPort", label: "SMTP port", type: "number" },
      { key: "notify.smtpUser", label: "SMTP username" },
      { key: "notify.smtpPassword", label: "SMTP password", type: "password" },
      { key: "notify.webhookUrl", label: "Slack or Teams webhook" },
    ],
  },
];

export function SettingsTab({ client }: { client: Client }) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["client-settings", client.id],
    queryFn: () => api.get<SettingsPayload>(`/api/clients/${client.id}/settings`),
  });

  useEffect(() => {
    if (data) setDraft(data.values);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put(`/api/clients/${client.id}/settings`, draft),
    onSuccess: () => {
      setNotice("Saved.");
      setTestResult(null);
      cache.invalidateQueries({ queryKey: ["client", String(client.id)] });
      cache.invalidateQueries({ queryKey: ["client-settings", client.id] });
      cache.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const test = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; error?: string; environment?: string; jobsVisible?: number | null }>(
        `/api/clients/${client.id}/settings/test`,
      ),
    onSuccess: (result) =>
      setTestResult(
        result.success
          ? {
              ok: true,
              text: `Connected to the ${result.environment} tenant${
                result.jobsVisible !== null && result.jobsVisible !== undefined
                  ? ` — ${result.jobsVisible.toLocaleString()} jobs visible.`
                  : "."
              }`,
            }
          : { ok: false, text: result.error ?? "Connection failed." },
      ),
  });

  function set(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  }

  return (
    <div className="stack">
      {SECTIONS.map((section) => (
        <div className="card" key={section.title}>
          <div className="card-head">
            <span className="eyebrow">{section.title}</span>
          </div>
          {section.note && <p className="section-note" style={{ marginBottom: "1rem" }}>{section.note}</p>}
          <div className="settings-grid">
            {section.fields.map((field) => {
              const isSecret = field.type === "password";
              const stored = data?.secretsSet?.[field.key];
              return (
                <label className="field" key={field.key}>
                  {field.label}
                  {field.type === "select" ? (
                    <select value={draft[field.key] ?? ""} onChange={(e) => set(field.key, e.target.value)}>
                      {field.options!.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={isSecret ? "password" : field.type === "number" ? "number" : "text"}
                      value={draft[field.key] ?? ""}
                      onChange={(e) => set(field.key, e.target.value)}
                      placeholder={isSecret && stored ? "•••••••• (saved)" : field.placeholder}
                      autoComplete="off"
                    />
                  )}
                  {field.hint && <span className="hint" style={{ fontWeight: 400 }}>{field.hint}</span>}
                  {isSecret && stored && (
                    <span className="hint" style={{ fontWeight: 400 }}>Saved. Leave blank to keep it.</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
        <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? "Testing…" : "Test ServiceTitan connection"}
        </button>
        {notice && <span className="muted">{notice}</span>}
      </div>

      {testResult && (
        <div className={`flash ${testResult.ok ? "flash-ok" : "flash-error"}`}>{testResult.text}</div>
      )}

      <p className="hint">
        The connection test does a real round trip against the saved credentials — a token exchange plus one cheap read
        — so a wrong app key or tenant ID surfaces here rather than three hours into an archive.
      </p>
    </div>
  );
}
