/**
 * Alcore readiness hold tests (task 55).
 *
 * The hold gates only alcore sends on `GET /api/alcore/readiness`; every
 * other provider and every unreadable gate sends at once. A syncing gate
 * holds briefly, a stuck gate fails with the named syncing code (never the
 * raw upstream "Provider unavailable"), and an external gate fails fast
 * with the restart code. The transport is stubbed at the `runtimeFetch`
 * seam; the hold's own bounds are narrowed per call so no test sleeps.
 */

import { describe, expect, mock, test } from "bun:test";

const fetches: Array<string> = [];
let answers: Array<Response | Error> = [];

const readinessJson = (state: string, needsRestart = false, status = 200) =>
  new Response(JSON.stringify({ state, needsRestart }), {
    status,
    headers: { "content-type": "application/json" },
  });

const malformedJson = () =>
  new Response(JSON.stringify({ nope: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock((input: string) => {
    fetches.push(input);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return Promise.resolve(next ?? readinessJson("ready"));
  }),
}));

const {
  ALCORE_PROVIDER_SYNCING_CODE,
  ALCORE_RESTART_REQUIRED_CODE,
  AlcoreReadinessError,
  ensureAlcoreProviderReady,
  isAlcoreReadinessError,
  isAlcoreRestartRequiredError,
} = await import("./alcoreReadiness");

const reset = (next: Array<Response | Error>) => {
  fetches.length = 0;
  answers = [...next];
};

const captureFailure = async (run: () => Promise<void>): Promise<InstanceType<typeof AlcoreReadinessError> | null> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof AlcoreReadinessError) return error;
    throw error;
  }
  return null;
};

describe("ensureAlcoreProviderReady", () => {
  test("non-alcore providers send without touching the gate", async () => {
    reset([]);
    await ensureAlcoreProviderReady("anthropic");
    expect(fetches).toHaveLength(0);
  });

  test("a ready gate sends at once", async () => {
    reset([readinessJson("ready")]);
    await ensureAlcoreProviderReady("alcore");
    expect(fetches).toEqual(["/api/alcore/readiness"]);
  });

  test("an idle gate sends at once", async () => {
    reset([readinessJson("idle")]);
    await ensureAlcoreProviderReady("alcore");
    expect(fetches).toHaveLength(1);
  });

  test("a syncing gate holds until the poll lands", async () => {
    reset([readinessJson("syncing"), readinessJson("syncing"), readinessJson("ready")]);
    await ensureAlcoreProviderReady("alcore", { timeoutMs: 1000, pollMs: 5 });
    expect(fetches).toHaveLength(3);
  });

  test("a stuck gate fails fast with the named syncing code", async () => {
    reset([readinessJson("syncing"), readinessJson("syncing_retry")]);
    const failure = await captureFailure(() =>
      ensureAlcoreProviderReady("alcore", { timeoutMs: 5, pollMs: 5 }),
    );
    expect(failure).toBeInstanceOf(AlcoreReadinessError);
    expect(failure?.code).toBe(ALCORE_PROVIDER_SYNCING_CODE);
    expect(isAlcoreReadinessError(failure)).toBe(true);
    expect(isAlcoreRestartRequiredError(failure)).toBe(false);
    expect(failure?.message ?? "").not.toContain("Provider unavailable");
  });

  test("an external gate fails fast with the restart code", async () => {
    reset([readinessJson("needs_restart", true)]);
    const failure = await captureFailure(() => ensureAlcoreProviderReady("alcore"));
    expect(failure?.code).toBe(ALCORE_RESTART_REQUIRED_CODE);
    expect(isAlcoreRestartRequiredError(failure)).toBe(true);
    expect(fetches).toHaveLength(1);
  });

  test("an unreadable gate fails open", async () => {
    reset([new Error("server down")]);
    await ensureAlcoreProviderReady("alcore");
    reset([malformedJson()]);
    await ensureAlcoreProviderReady("alcore");
    reset([readinessJson("ready", false, 500)]);
    await ensureAlcoreProviderReady("alcore");
  });
});
