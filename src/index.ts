import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import { env } from "./config/env";
import { db } from "./db/index";
import { apiRouter } from "./api/router";
import { SqliteSessionStore } from "./lib/sessionStore";
import { verifyOrigin } from "./middleware/verifyOrigin";
import { securityHeaders } from "./middleware/securityHeaders";
import { noStore } from "./middleware/noStore";
import { getSetting, setSetting } from "./db/clientSettings";
import { failInterruptedRuns } from "./db/runs";
import { sweepExpiredArchives } from "./servicetitan/archiveRun";

const app = express();
app.set("trust proxy", 1);
app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));

// Survives restarts in SQLite rather than living in memory, so a redeploy
// doesn't sign everyone out mid-archive.
let sessionSecret = getSetting("app.sessionSecret");
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  setSetting("app.sessionSecret", sessionSecret);
}

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use("/api", verifyOrigin, noStore, apiRouter);

// The built SPA. index: false so every unmatched path falls through to the
// catch-all below and React Router handles it, rather than express.static
// serving index.html for directories only.
const clientDist = path.join(__dirname, "../client/dist");
app.use("/app", express.static(clientDist, { index: false }));
app.get(/^\/app(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});
app.get("/", (_req, res) => res.redirect("/app"));

app.get("/healthz", (_req, res) => {
  const row = db.prepare("SELECT count(*) AS n FROM clients").get() as { n: number };
  res.json({ ok: true, clients: row.n });
});

// An archive runs inside this process, so a restart kills it mid-run without
// touching its row. Left alone that row stays "running" forever and blocks
// the next archive for that client; this closes it out honestly. The sweep
// then clears archives past their retention window, which otherwise
// accumulate at tens of gigabytes each.
const interrupted = failInterruptedRuns();
if (interrupted > 0) console.log(`Marked ${interrupted} interrupted archive run(s) as failed`);
const swept = sweepExpiredArchives();
if (swept > 0) console.log(`Removed ${swept} expired archive file(s)`);

app.listen(env.PORT, () => {
  console.log(`Photo Archive listening on http://localhost:${env.PORT}/app`);
});
