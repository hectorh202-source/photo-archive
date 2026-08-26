import type { NextFunction, Request, Response } from "express";

// Every authenticated surface (the /settings console, the JSON API, and the
// React SPA's HTML shell) must never be servable from the browser's HTTP
// cache OR its back/forward cache (bfcache) — otherwise hitting the back
// button after logging out (or switching users in the same tab) can
// resurrect a fully-rendered page from a previous session without the
// browser ever asking the server again, bypassing whatever auth check would
// normally run. `no-store` is the one directive that reliably disqualifies a
// response from both caches; `Pragma: no-cache` is a legacy fallback for
// very old HTTP/1.0 caches that don't understand Cache-Control.
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
}
