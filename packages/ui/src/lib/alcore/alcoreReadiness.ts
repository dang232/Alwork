/**
 * Alcore readiness hold (task 55 — the post-login race).
 *
 * After an Alcore login the server polls its managed OpenCode model surface
 * for the alcore entries before the sync counts as complete
 * (`syncOnLogin`, `GET /api/alcore/readiness`). A first prompt dispatched
 * before that poll lands loses with the raw upstream "Provider unavailable"
 * (see `.omo/evidence/task-54-provider-unavailable.md`). Every send through
 * `opencodeClient` calls `ensureAlcoreProviderReady` first: non-alcore
 * providers return immediately, a ready or idle gate sends at once, a
 * syncing gate holds briefly, and only a gate still unsettled after the
 * bounded hold fails — with the named syncing state, never the raw
 * provider error. An external OpenCode never sees this process's config
 * write, so its gate reports `needs_restart` and the send fails fast with
 * restart guidance instead of polling a surface that cannot change.
 *
 * The hold fails open: an unreachable or unknown readiness answer sends
 * immediately, so an older server (no route) or a momentary blip never
 * blocks a prompt that would have succeeded.
 *
 * Surfaces (ui-api-decoupling): web, Electron desktop, hosted mobile, and
 * Capacitor mobile share this client path wherever this server runs;
 * VS Code runs no such server (no Alcore card there) so its gate answers
 * idle and sends proceed. User-facing text lives in the i18n dictionaries
 * (`chat.alcore.readiness.*`); the errors below carry machine codes plus
 * an English fallback for surfaces that render `error.message` directly.
 */

import { z } from "zod";

import { runtimeFetch } from "@/lib/runtime-fetch";

const ALCORE_PROVIDER_ID = "alcore";
export const ALCORE_PROVIDER_SYNCING_CODE = "ALCORE_PROVIDER_SYNCING";
export const ALCORE_RESTART_REQUIRED_CODE = "ALCORE_RESTART_REQUIRED";

// How long a send holds on a syncing gate before failing fast with the
// named state. Long enough for the server's own poll to land first in the
// common case, short enough that a stuck gate never feels hung.
const HOLD_TIMEOUT_MS = 10_000;
const HOLD_POLL_MS = 500;

const alcoreReadinessStateSchema = z.enum(["idle", "syncing", "ready", "syncing_retry", "needs_restart"]);

type AlcoreReadinessState = z.infer<typeof alcoreReadinessStateSchema>;

export class AlcoreReadinessError extends Error {
  readonly code: string;
  readonly needsRestart: boolean;
  constructor(code: string, needsRestart: boolean, message: string) {
    super(message);
    this.name = "AlcoreReadinessError";
    this.code = code;
    this.needsRestart = needsRestart;
  }
}

// The `GET /api/alcore/readiness` body, parsed at this boundary: anything
// the server answers that is not this shape reads as an unreadable gate
// (fail open), never as trusted state.
const readinessSnapshotSchema = z.object({
  state: alcoreReadinessStateSchema,
  needsRestart: z.boolean().optional(),
});

type ReadinessSnapshot = { state: AlcoreReadinessState; needsRestart: boolean };

const readSnapshot = async (): Promise<ReadinessSnapshot | null> => {
  const response = await runtimeFetch("/api/alcore/readiness");
  if (!response.ok) return null;
  const parsed = readinessSnapshotSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;
  return { state: parsed.data.state, needsRestart: parsed.data.needsRestart === true };
};

const throwForState = (snapshot: ReadinessSnapshot): never => {
  if (snapshot.state === "needs_restart" || snapshot.needsRestart) {
    throw new AlcoreReadinessError(
      ALCORE_RESTART_REQUIRED_CODE,
      true,
      "Restart your OpenCode to finish Alcore setup, then send again.",
    );
  }
  throw new AlcoreReadinessError(
    ALCORE_PROVIDER_SYNCING_CODE,
    false,
    "Alcore provider is still syncing. Retry in a moment.",
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Hold an alcore send on the login readiness gate. Resolves when the send
 * may proceed; throws `AlcoreReadinessError` with the named state when it
 * must not. Never throws for non-alcore providers or for an unreadable
 * gate — the send proceeds exactly as it would without this hold.
 *
 * `options` only narrows the bounded hold (tests); production always uses
 * the module bounds above.
 */
export async function ensureAlcoreProviderReady(
  providerID: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  if (providerID !== ALCORE_PROVIDER_ID) return;
  const timeoutMs = options?.timeoutMs ?? HOLD_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? HOLD_POLL_MS;
  let snapshot: ReadinessSnapshot | null;
  try {
    snapshot = await readSnapshot();
  } catch {
    return;
  }
  if (snapshot === null) return;
  if (snapshot.state === "ready" || snapshot.state === "idle") return;
  if (snapshot.state === "needs_restart" || snapshot.needsRestart) throwForState(snapshot);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) throwForState(snapshot);
    await sleep(pollMs);
    try {
      snapshot = await readSnapshot();
    } catch {
      return;
    }
    if (snapshot === null) return;
    if (snapshot.state === "ready" || snapshot.state === "idle") return;
    if (snapshot.state === "needs_restart" || snapshot.needsRestart) throwForState(snapshot);
  }
}

export const isAlcoreReadinessError = (error: unknown): error is AlcoreReadinessError =>
  error instanceof AlcoreReadinessError;

export const isAlcoreRestartRequiredError = (error: unknown): boolean =>
  error instanceof AlcoreReadinessError && error.needsRestart;
