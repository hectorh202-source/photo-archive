import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Client, type SettingsPayload } from "../api";

// One section at a time, in the order they matter: you cannot do anything
// without the connection, most people never touch the pace, and delivery is
// mostly future. A single 31-field wall made all of that look equally urgent.

interface FieldDef {
  key: string;
  label: string;
  help?: string;
  type?: "text" | "password" | "number" | "select";
  options?: { value: string; label: string }[];
  placeholder?: string;
  wide?: boolean;
}

interface SectionDef {
  id: string;
  nav: string;
  title: string;
  blurb: string;
  fields: FieldDef[];
  single?: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    id: "connection",
    nav: "Connection",
    title: "ServiceTitan connection",
    blurb:
      "The account photos are read from. Everything this app does is read-only — it never creates, changes, or deletes anything in ServiceTitan. Copy these four values from the client's ServiceTitan developer portal.",
    fields: [
      {
        key: "st.environment",
        label: "Which ServiceTitan",
        type: "select",
        options: [
          { value: "production", label: "Production — their real data" },
          { value: "integration", label: "Sandbox — test data only" },
        ],
        help: "Sandbox holds separate made-up data, so real job numbers will not be found there.",
      },
      { key: "st.tenantId", label: "Tenant ID", placeholder: "1234567890" },
      { key: "st.clientId", label: "Client ID" },
      {
        key: "st.clientSecret",
        label: "Client Secret",
        type: "password",
        help: "Encrypted before it is stored, and never sent back to this page.",
      },
      { key: "st.appKey", label: "App Key" },
    ],
  },
  {
    id: "output",
    nav: "What you get",
    title: "What the archive contains",
    blurb:
      "How photos are named and filed inside each monthly zip. The defaults produce folders like 88801 - Dana Whitfield - 2026-07-03 holding Dana Whitfield - 2026-07-03 - 001.jpg.",
    single: true,
    fields: [
      {
        key: "run.contents",
        label: "Include",
        type: "select",
        options: [
          { value: "photos", label: "Photos only" },
          { value: "attachments", label: "Photos and documents (invoices, signed estimates)" },
        ],
        help: "A job's attachments are not all pictures. Photos-only skips the PDFs without even downloading them.",
      },
      {
        key: "run.photoNameTemplate",
        label: "Name each photo",
        placeholder: "{customer} - {date} - {n}",
        help: "Available: {customer} {date} {jobNumber} {n}. Documents keep the name ServiceTitan gave them.",
      },
      {
        key: "run.jobFolderTemplate",
        label: "Name each job folder",
        placeholder: "{jobNumber} - {customer} - {date}",
      },
      {
        key: "run.includeManifest",
        label: "Include a manifest",
        type: "select",
        options: [
          { value: "1", label: "Yes — list anything skipped or failed" },
          { value: "0", label: "No" },
        ],
        help: "The manifest is the only record of a photo that failed to download. Without it, a gap is invisible.",
      },
    ],
  },
  {
    id: "pace",
    nav: "Speed",
    title: "Speed and limits",
    blurb:
      "How hard this app is allowed to pull on the client's ServiceTitan account. While they are still running their business on it, a dispatcher waiting on a customer lookup matters more than an archive finishing sooner. The defaults are safe — most clients never need these changed.",
    fields: [
      {
        key: "run.requestsPerSecond",
        label: "Requests per second",
        type: "number",
        help: "5 is gentle. Above 10 you start competing with their own technicians.",
      },
      { key: "run.maxRetries", label: "Retries per request", type: "number", help: "Used when ServiceTitan rate-limits or errors." },
      { key: "run.maxFileMb", label: "Skip files larger than (MB)", type: "number" },
      { key: "run.maxRunGb", label: "Stop the archive at (GB)", type: "number" },
    ],
  },
  {
    id: "delivery",
    nav: "Delivery",
    title: "Where finished archives go",
    blurb:
      "Today archives are built here and you hand them over yourself — download each month and upload it to the client's drive. The cloud options are not built yet; their fields exist so credentials have an encrypted home the day each one is.",
    fields: [
      {
        key: "delivery.target",
        label: "Deliver by",
        type: "select",
        options: [
          { value: "download", label: "Download from this app (available now)" },
          { value: "googleDrive", label: "Google Drive — not built yet" },
          { value: "dropbox", label: "Dropbox — not built yet" },
          { value: "sharepoint", label: "SharePoint / OneDrive — not built yet" },
          { value: "s3", label: "S3 or Backblaze — not built yet" },
        ],
      },
      { key: "delivery.googleDrive.folderId", label: "Google Drive folder ID" },
      { key: "delivery.googleDrive.refreshToken", label: "Google Drive refresh token", type: "password" },
      { key: "delivery.dropbox.path", label: "Dropbox folder path", placeholder: "/Job photos" },
      { key: "delivery.dropbox.refreshToken", label: "Dropbox refresh token", type: "password" },
      { key: "delivery.sharepoint.driveId", label: "SharePoint drive ID" },
      { key: "delivery.sharepoint.folderPath", label: "SharePoint folder path" },
      { key: "delivery.s3.bucket", label: "Bucket" },
      { key: "delivery.s3.region", label: "Region" },
      { key: "delivery.s3.endpoint", label: "Endpoint", placeholder: "https://s3.us-west-001.backblazeb2.com" },
      { key: "delivery.s3.accessKeyId", label: "Access key ID" },
      { key: "delivery.s3.secretAccessKey", label: "Secret access key", type: "password" },
    ],
  },
  {
    id: "notify",
    nav: "Notifications",
    title: "Telling you it finished",
    blurb: "An archive runs for days. These are how you hear about it without watching the page.",
    fields: [
      { key: "notify.emailTo", label: "Email results to", placeholder: "you@example.com" },
      { key: "notify.smtpHost", label: "SMTP server" },
      { key: "notify.smtpPort", label: "Port", type: "number" },
      { key: "notify.smtpUser", label: "Username" },
      { key: "notify.smtpPassword", label: "Password", type: "password" },
      { key: "notify.webhookUrl", label: "Slack or Teams webhook", wide: true },
    ],
  },
];

export function SettingsTab({ client }: { client: Client }) {
  const cache = useQueryClient();
  const [section, setSection] = useState(SECTIONS[0].id);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
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
      setDirty(false);
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
              text: `Connected to their ${result.environment} account${
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
    setDirty(true);
    setNotice("");
  }

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="settings">
      <nav className="settings-nav">
        {SECTIONS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={section === s.id ? "active" : ""}
            onClick={() => setSection(s.id)}
          >
            <span className="step">{String(i + 1).padStart(2, "0")}</span>
            {s.nav}
          </button>
        ))}
      </nav>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h2>{current.title}</h2>
          </div>
          <div className="card-body">
            <p className="sub" style={{ maxWidth: "62ch" }}>{current.blurb}</p>

            <div className={`field-grid ${current.single ? "single" : ""}`}>
              {current.fields.map((field) => {
                const isSecret = field.type === "password";
                const stored = data?.secretsSet?.[field.key];
                return (
                  <label className="field" key={field.key} style={field.wide ? { gridColumn: "1 / -1" } : undefined}>
                    <span>{field.label}</span>
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
                        placeholder={isSecret && stored ? "•••••••••• saved" : field.placeholder}
                        autoComplete="off"
                      />
                    )}
                    {field.help && <span className="help">{field.help}</span>}
                    {isSecret && stored && !field.help && (
                      <span className="help">Saved — leave blank to keep it.</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {current.id === "connection" && (
            <div className="card-foot">
              <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>
                {test.isPending ? "Testing…" : "Test connection"}
              </button>
              <span className="tiny">
                Signs in to ServiceTitan with these credentials and reads one job, so a wrong value shows up now rather
                than hours into an archive.
              </span>
            </div>
          )}
        </div>

        {testResult && (
          <div className={`notice ${testResult.ok ? "notice-info" : "notice-bad"}`}>{testResult.text}</div>
        )}

        <div className="save-bar">
          <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
          <span className="sub">
            {notice || (dirty ? "Unsaved changes" : "All settings apply to this client only.")}
          </span>
        </div>
      </div>
    </div>
  );
}
