import type { DocumentState, History } from "./model.ts";

/** Groups a continuous interaction (slider drag, point drag, wheel burst)
 * into a single undo entry.
 *
 * A gesture is identified by a key. A checkpoint whose key matches the live
 * gesture reuses the entry it already pushed; a different key, a commit(),
 * or end() closes the gesture, so the next checkpoint pushes again.
 * `generation` counts pushes, letting accumulators (the angle wheel) notice
 * that another edit slipped in between their events. Every push runs onPush,
 * which the editor uses to void the pending "double click cancels the
 * just-added point" window. */
export class Gestures {
  private key = "";
  private expires = -Infinity;
  private pushes = 0;
  private history: History;
  private onPush: () => void;
  constructor(history: History, onPush: () => void = () => {}) {
    this.history = history;
    this.onPush = onPush;
  }
  /** Total pushes so far, from checkpoints and commits alike. */
  get generation() {
    return this.pushes;
  }
  /** Whether a checkpoint for this key would continue the live gesture. */
  live(key: string) {
    return key === this.key && performance.now() <= this.expires;
  }
  /** One undo entry per gesture: pushes `before` when a gesture starts and
   * reuses (extending the timeout) while it continues. Returns true on push. */
  checkpoint(key: string, before: DocumentState, timeoutMs = Infinity) {
    const continued = this.live(key);
    this.key = key;
    this.expires = performance.now() + timeoutMs;
    if (continued) return false;
    this.push(before);
    return true;
  }
  /** A one-shot edit: always its own entry, closing any live gesture. */
  commit(state: DocumentState) {
    this.end();
    this.push(state);
  }
  /** Close the live gesture; the next checkpoint starts a new entry. */
  end() {
    this.key = "";
    this.expires = -Infinity;
  }
  private push(state: DocumentState) {
    this.history.push(state);
    this.pushes++;
    this.onPush();
  }
}
