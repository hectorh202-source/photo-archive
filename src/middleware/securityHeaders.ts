import type { Request, Response, NextFunction } from "express";

// script-src is a clean 'self' with no exception — the auth pages' old
// inline bfcache-reload <script> (the one thing that ever needed a CSP hash
// here) moved into the React SPA as regular bundled JS when the pre-session
// auth pages folded into the SPA (see client/src/main.tsx), so there is no
// remaining inline <script> anywhere in the app.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' is needed here: the React client renders inline
  // style={{}} attributes throughout. Nothing else in the app needs it.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // Without an explicit media-src, browsers fall back to default-src
  // ('self') for <audio>/<video>, silently blocking the Voices page's
  // preview playback. Confirmed against a real account (2026-07-15) that
  // ElevenLabs serves previews from *two* different hosts depending on the
  // voice — most from storage.googleapis.com, but some (seemingly
  // region-routed) from api.<region>.elevenlabs.io (api.us.elevenlabs.io
  // for this account) — allowing only the exact host we happened to see
  // left those silently broken too. *.elevenlabs.io covers any region.
  // blob: is separately required for the "test these settings" button's
  // generated audio (an object URL, not a real host) — confirmed via a
  // real repro that 'self' does NOT implicitly cover the blob: scheme:
  // a locally-rendered, independently-decodable WAV blob still failed to
  // load through <audio> with 'self' alone, and started working the
  // moment blob: was added.
  "media-src 'self' blob: https://storage.googleapis.com https://*.elevenlabs.io",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Applied app-wide, first in the middleware chain. Individual routers (e.g.
// dashboard/routes.ts) may still set their own additional/stricter headers
// afterward — since res.setHeader replaces rather than appends, a more
// specific value set later in the chain wins for that router's routes.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Browsers ignore this header entirely over a plain http:// connection, so
  // it's safe to always send — it only takes effect once Caddy's HTTPS is
  // actually in front of a request.
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  next();
}
