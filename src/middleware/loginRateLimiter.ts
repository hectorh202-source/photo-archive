// Hand-rolled per-IP sliding-window throttle for the login/migrate routes —
// intentionally in-memory (not persisted like the per-account lockout in
// db/users.ts), since only account-level lockout needs to survive a
// restart. Requires app.set("trust proxy", ...) upstream so req.ip reflects
// the real client through Caddy rather than its internal address.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 20;
const attempts = new Map<string, number[]>();

function prune(ip: string): number[] {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, list);
  return list;
}

export function recordFailedLoginAttempt(ip: string): void {
  const list = prune(ip);
  list.push(Date.now());
}

// Pure check (no Express dependency) — used inline by api/authRouter.ts's
// login/migrate handlers, which build their own JSON 429 response, the same
// way isForgotPasswordRateLimited below already works.
export function isLoginRateLimited(ip: string): boolean {
  return prune(ip).length >= MAX_ATTEMPTS_PER_IP;
}

// A separate counter/map from the login one above — a burst of forgot-
// password requests shouldn't consume or be consumed by login-attempt
// budget, since they're different abuse patterns (spamming an inbox with
// reset emails vs. guessing a password). Deliberately more permissive than
// login's 20/15min: a legitimate user might reasonably retry a few times if
// an email doesn't show up right away.
const MAX_RESET_REQUESTS_PER_IP = 10;
const resetAttempts = new Map<string, number[]>();

function pruneReset(ip: string): number[] {
  const now = Date.now();
  const list = (resetAttempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  resetAttempts.set(ip, list);
  return list;
}

export function isForgotPasswordRateLimited(ip: string): boolean {
  return pruneReset(ip).length >= MAX_RESET_REQUESTS_PER_IP;
}

export function recordForgotPasswordRequest(ip: string): void {
  const list = pruneReset(ip);
  list.push(Date.now());
}
