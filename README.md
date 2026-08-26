# Photo Archive

Pulls a ServiceTitan tenant's job photos out and packages them as a deliverable archive: one zip per month, a folder per job, every photo named for the customer and the job's date.

Built for one errand — a contractor leaving ServiceTitan whose photo history leaves with the subscription. There is no bulk photo export in ServiceTitan, and once an account lapses the photos are unreachable at any price.

Read-only against ServiceTitan throughout. Every call is a `GET`; nothing is created, changed, or deleted in a client's tenant.

## Running it

```bash
npm install && npm run dev          # server on :3100
npm --prefix client run dev         # interface on :5273 (dev only)
```

In production the server serves the built interface itself, so only the first command runs. Open `/app`, and the first visit creates the first account — after that the setup form never appears again.

```bash
docker compose up -d --build
```

## How the work is organized

**Clients** are the unit. One row per contractor whose tenant is being archived, each with its own ServiceTitan credentials, its own pacing, and its own cutover date — the day their account lapses, shown as a countdown because it is the deadline the whole job runs against.

Each client has three tabs:

- **Archive** — the whole tenant, or any date range of it. Size it up first, start it, watch it, download month by month.
- **Single job** — one job on demand, in four flavors: photos only, all attachments, everything including records, or records only. The errand that arrives by phone.
- **Settings** — every credential and knob, below.

## Settings

| Section | Holds |
| --- | --- |
| ServiceTitan | Environment, tenant ID, client ID, secret, app key |
| Pace and limits | Requests/second, retries, max file size, max archive size |
| Output | Photos vs all attachments, filename and folder templates, manifest |
| Delivery | Download today; Google Drive, Dropbox, SharePoint, S3 fields ready for when each is implemented |
| Notifications | Email results, SMTP, Slack/Teams webhook |

Secrets are write-only. The API reports whether one is set, never what it is, so a stolen session cannot read a client's ServiceTitan secret back out.

Everything is encrypted at rest with AES-256-GCM. Set `ENCRYPTION_KEY` in the environment before storing real credentials — without it the key falls back to a file inside the data volume, where a leaked backup carries both the ciphertext and the key. Changing the key later makes everything already stored permanently unreadable.

## What an archive run does

1. **Estimate** — exact job count from the list endpoint, photo count projected from 30 jobs sampled evenly across the range. Counting photos exactly would cost the same tens of thousands of requests as the archive itself, so the page says which number is which.
2. **Retrieve** — one attachment listing per job, one download per photo, paced. Failures retry; anything unrecoverable is named in the manifest rather than dropped silently.
3. **Package** — a zip per month, a folder per job (`88801 - Dana Whitfield - 2026-07-03/`), each photo named `Dana Whitfield - 2026-07-03 - 001.jpg`.

Monthly for failure isolation: a run that dies in October leaves January through September downloadable. Months split half-open, so a job completed at midnight on the 1st lands in exactly one file.

Runs live in SQLite, not memory. A restart marks an interrupted run failed instead of leaving it stuck at "running" forever, and finished months stay downloadable.

## Things learned the hard way

Recorded here because none of it is in ServiceTitan's documentation and all of it cost real debugging:

- **Photos are in the Forms module, not JPM.** `GET /forms/v2/tenant/{t}/jobs/{jobId}/attachments` lists, `GET /forms/v2/tenant/{t}/jobs/attachment/{id}` downloads. The tenant's app needs the Forms scope granted separately.
- **The attachment id format is undocumented** — the list endpoint has no response schema at all. `downloadJobAttachment()` tries every plausible key in order and treats 404/400 as "wrong key, next".
- **Every attachment downloads as `application/octet-stream`,** JPEGs included. Content-Type can never be the deciding vote on whether something is a photo — the filename is, and the bytes are the tiebreaker. An earlier version got this wrong and shipped an archive containing nothing but a manifest.
- **`originalFileName` comes back null** on real rows; the real name is in `fileName`, carrying a folder prefix like `Attaches/` or `CapturedDocs/`.
- **The forms submissions owner filter was ignored** on the tenant tested, returning tenant-wide rows for a single job. Owner is verified client-side.
- **A job number is not a job ID.** Both are plain digits. Lookup tries the ID, falls back to a number search, and reports which matched.

## Layout

```
src/
  servicetitan/   auth, http, pagination, attachments, single-job export, archive runner
  db/             clients, per-client encrypted settings, runs, users, audit
  api/router.ts   the whole API
client/src/       the interface
```
