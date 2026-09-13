/** Serializes cancellable render jobs behind a generation counter.
 *
 * Every request advances the generation and marks the current result stale;
 * the running job observes this through its `cancelled` callback and aborts
 * between strokes. Only a job that finishes while still being the newest
 * generation counts as complete. The queue knows nothing about the DOM —
 * status text, buttons and progress belong to the hooks. */
export type RenderHooks<Snapshot> = {
  /** Immutable copy of the document to render. */
  snapshot: () => Snapshot;
  /** The queue transitions from idle to running. */
  begin: () => void;
  /** A job starts for this snapshot. */
  started: (snapshot: Snapshot) => void;
  /** The actual render; resolves false when cancelled. */
  run: (snapshot: Snapshot, cancelled: () => boolean) => Promise<boolean>;
  /** A job finished as the newest generation. */
  completed: (snapshot: Snapshot, elapsedMs: number) => void;
  /** The newest generation's job threw (stale failures are dropped). */
  failed: (error: unknown) => void;
  /** No more work; `complete` says whether the result is current. */
  idle: (complete: boolean) => void;
};
export class RenderQueue<Snapshot> {
  private generation = 0;
  private queued = false;
  private running = false;
  private completedGeneration = -1;
  private waiters: (() => void)[] = [];
  private hooks: RenderHooks<Snapshot>;
  constructor(hooks: RenderHooks<Snapshot>) {
    this.hooks = hooks;
  }
  /** The current generation — bump-on-edit consumers key caches off this. */
  get revision() {
    return this.generation;
  }
  get busy() {
    return this.running;
  }
  get complete() {
    return this.completedGeneration === this.generation;
  }
  /** Render the current state, cancelling whatever became stale. */
  request() {
    this.generation++;
    this.queued = true;
    this.completedGeneration = -1;
    if (!this.running) void this.drain();
  }
  /** Abandon the running job. Returns false when nothing was running. */
  cancel() {
    if (!this.running) return false;
    this.generation++;
    this.queued = false;
    this.completedGeneration = -1;
    return true;
  }
  /** Mark everything stale without queueing new work (context loss, image swap). */
  invalidate() {
    this.generation++;
    this.queued = false;
    this.completedGeneration = -1;
  }
  /** Resolves once no job is running — for releasing resources a job may hold. */
  whenIdle(): Promise<void> {
    return this.running
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
  private async drain() {
    this.running = true;
    this.hooks.begin();
    while (this.queued) {
      this.queued = false;
      const current = this.generation,
        snapshot = this.hooks.snapshot(),
        start = performance.now();
      this.hooks.started(snapshot);
      try {
        const done = await this.hooks.run(
          snapshot,
          () => current !== this.generation,
        );
        if (done) {
          this.completedGeneration = current;
          this.hooks.completed(snapshot, performance.now() - start);
        }
      } catch (error) {
        if (current === this.generation) this.hooks.failed(error);
      }
    }
    this.running = false;
    this.hooks.idle(this.complete);
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
