/**
 * OIL — Startup hydration gate
 *
 * The MCP handshake must not wait on the vault. A stdio server that indexes
 * before it connects makes its own availability a function of vault size and
 * filesystem latency, so a cold index or a not-yet-mounted vault reads to the
 * client as "the server failed" rather than "the server is still warming".
 *
 * This gate inverts that: the transport connects immediately and the expensive
 * work runs behind a promise that tool calls await. A failed attempt is
 * retried in the background, so a vault that appears late (cloud sync, network
 * share, machine wake) heals without the client reconnecting.
 */

export type HydrationPhase = "warming" | "ready" | "failed";

export interface HydrationSnapshot {
  phase: HydrationPhase;
  attempts: number;
  reason: string | null;
  /** Milliseconds the successful attempt took, or null while it has not succeeded. */
  duration_ms: number | null;
}

export interface HydrationOptions {
  /**
   * Backoff schedule between background retries. The last entry repeats, so an
   * absent vault keeps being re-checked rather than giving up permanently.
   */
  retryDelaysMs?: number[];
  /**
   * How long a gated tool call waits before answering with a diagnosis.
   * Below the MCP SDK's 60s request timeout on purpose: a caller should get a
   * named reason, not a client-side timeout with no explanation.
   */
  gateTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  log?: (message: string) => void;
}

const DEFAULT_RETRY_DELAYS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class Hydration {
  private readonly task: () => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly gateTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private phase: HydrationPhase = "warming";
  private reason: string | null = null;
  private attempts = 0;
  private durationMs: number | null = null;

  private inFlight: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(task: () => Promise<void>, options: HydrationOptions = {}) {
    this.task = task;
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_RETRY_DELAYS;
    this.gateTimeoutMs = options.gateTimeoutMs ?? 55_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
  }

  get snapshot(): HydrationSnapshot {
    return {
      phase: this.phase,
      attempts: this.attempts,
      reason: this.reason,
      duration_ms: this.durationMs,
    };
  }

  get ready(): boolean {
    return this.phase === "ready";
  }

  /** Kick off the first attempt. Never throws — failures become state. */
  begin(): void {
    if (this.stopped || this.phase === "ready" || this.inFlight) return;
    void this.attempt().catch(() => undefined);
  }

  /**
   * Await a usable vault.
   *
   * Resolves immediately once hydrated. While warming it waits for the attempt
   * in flight; if hydration has failed it triggers a fresh attempt rather than
   * replaying a stale error, so the first call after a vault appears succeeds.
   */
  async whenReady(): Promise<void> {
    if (this.phase === "ready") return;
    if (this.stopped) throw new Error("OIL is shutting down.");

    // A failed attempt leaves no promise behind. Rather than replaying a stale
    // error, the first call after the vault appears drives a new attempt — the
    // pending backoff is collapsed into it so the caller does not wait for it.
    if (this.phase === "failed" && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const attempt = this.attempt();

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `OIL is still indexing the vault after ${Math.round(this.gateTimeoutMs / 1000)}s. ` +
                  "Retry shortly, or call get_health for startup detail.",
              ),
            );
          }, this.gateTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!this.ready) {
      throw new Error(this.reason ?? "OIL could not index the vault.");
    }
  }

  /** Stop retrying. Called on shutdown so a pending backoff cannot hold the process open. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Run one hydration attempt, coalescing onto one already in flight.
   *
   * The retained promise deliberately never rejects: an attempt with no waiting
   * caller must not surface as an unhandled rejection, which on Node 20+ tears
   * the whole server down. Callers observe the outcome through `phase` instead.
   */
  private attempt(): Promise<void> {
    if (this.inFlight) return this.settle(this.inFlight);

    const started = this.now();
    const token = ++this.attempts;

    const run = (async () => {
      try {
        await this.task();
        this.phase = "ready";
        this.reason = null;
        this.durationMs = this.now() - started;
        this.log(`[OIL] Vault ready in ${this.durationMs}ms (attempt ${token}).`);
      } catch (err) {
        this.phase = "failed";
        this.reason = describe(err);
        this.log(
          `[OIL] Vault not ready (${this.reason}). Tools will report this until it clears.`,
        );
        this.scheduleRetry();
      } finally {
        // Cleared so `inFlight` means "pending", never "the last one finished".
        if (this.attempts === token) this.inFlight = null;
      }
    })();

    this.inFlight = run;
    return this.settle(run);
  }

  private settle(attempt: Promise<void>): Promise<void> {
    return attempt.then(() => {
      if (!this.ready) throw new Error(this.reason ?? "Vault unavailable.");
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const index = Math.min(this.attempts - 1, this.retryDelaysMs.length - 1);
    const delay = this.retryDelaysMs[index];

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.inFlight = null;
      if (this.stopped || this.phase === "ready") return;
      void this.attempt().catch(() => undefined);
    }, delay);
    // Never keep the process alive purely to retry.
    this.retryTimer.unref?.();
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
