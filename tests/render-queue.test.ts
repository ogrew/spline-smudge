import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderQueue } from "../src/render-queue.ts";

type Job = { snapshot: number; cancelled: () => boolean };
function harness() {
  const log: string[] = [];
  const jobs: ((done: boolean) => void)[] = [];
  let generation = 0;
  const queue = new RenderQueue<number>({
    snapshot: () => ++generation,
    begin: () => log.push("begin"),
    started: (snapshot) => log.push(`start:${snapshot}`),
    run: (snapshot, cancelled) =>
      new Promise((resolve) =>
        jobs.push((done) => resolve(done && !cancelled())),
      ),
    completed: (snapshot) => log.push(`done:${snapshot}`),
    failed: (error) => log.push(`fail:${String(error)}`),
    idle: (complete) => log.push(`idle:${complete}`),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  return { queue, log, jobs, settle };
}

test("requests during a run coalesce into one follow-up with the newest state", async () => {
  const { queue, log, jobs, settle } = harness();
  queue.request();
  await settle();
  queue.request();
  queue.request();
  jobs[0](true); // Finishes, but two newer requests made it stale.
  await settle();
  jobs[1](true);
  await settle();
  assert.deepEqual(log, ["begin", "start:1", "start:2", "done:2", "idle:true"]);
  assert.equal(queue.complete, true);
  assert.equal(queue.busy, false);
});

test("cancel abandons the running job and leaves the result incomplete", async () => {
  const { queue, log, jobs, settle } = harness();
  queue.request();
  await settle();
  assert.equal(queue.cancel(), true);
  assert.equal(queue.cancel(), true); // Still running until the job observes it.
  jobs[0](true);
  await settle();
  assert.deepEqual(log, ["begin", "start:1", "idle:false"]);
  assert.equal(queue.complete, false);
  assert.equal(queue.cancel(), false); // Nothing left to cancel once idle.
});

test("whenIdle resolves after the loop drains; failures only surface when current", async () => {
  const log: string[] = [];
  let reject: (error: unknown) => void = () => {};
  const queue = new RenderQueue<string>({
    snapshot: () => "s",
    begin: () => {},
    started: () => {},
    run: () => new Promise((_, r) => (reject = r)),
    completed: () => {},
    failed: (error) => log.push(`fail:${String(error)}`),
    idle: () => log.push("idle"),
  });
  assert.equal(await Promise.race([queue.whenIdle().then(() => "idle")]), "idle");
  queue.request();
  const waited = queue.whenIdle().then(() => log.push("released"));
  queue.invalidate(); // The failure below belongs to a stale generation.
  reject(new Error("boom"));
  await waited;
  assert.deepEqual(log, ["idle", "released"]);
  queue.request();
  await new Promise((resolve) => setTimeout(resolve));
  reject(new Error("boom"));
  await queue.whenIdle();
  assert.deepEqual(log, ["idle", "released", "fail:Error: boom", "idle"]);
});
