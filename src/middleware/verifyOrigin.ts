import type { Request, Response, NextFunction } from "express";

// CSRF defense for /api, alongside the session cookie's
// SameSite=Lax attribute (index.ts) — Lax already stops a cross-site POST
// from attaching the session cookie at all in every modern browser, which
// is the primary defense. This is a second, independent check that doesn't
// depend on cookie behavior: reject any state-changing request whose
// Origin (or, if absent, Referer) header doesn't match this app's own
// origin. Only applied to /api — never to /b/:businessId/tools
// or /webhooks, which are server-to-server calls (ElevenLabs, no browser)
// authenticated by a shared secret instead of a session, and legitimately
// carry no Origin/Referer at all.
export function verifyOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }

  const { origin, referer, host } = req.headers;
  let sourceOrigin: string | undefined = typeof origin === "string" ? origin : undefined;
  if (!sourceOrigin && typeof referer === "string") {
    try {
      sourceOrigin = new URL(referer).origin;
    } catch {
      sourceOrigin = undefined;
    }
  }

  if (!sourceOrigin || !host || sourceOrigin !== `${req.protocol}://${host}`) {
    res.status(403).json({ error: "Cross-origin request rejected" });
    return;
  }

  next();
}
