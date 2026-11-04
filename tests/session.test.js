import { test } from "node:test";
import assert from "node:assert/strict";
import { HitDetector } from "../js/detector.js";
import { makeJumpAudio } from "../js/synth.js";
import { Session, trimTail, summarize, AUTO_STOP_MS } from "../js/session.js";

const hitsAt = (times) => times.map((t) => ({ t, db: -20 }));
const every = (start, gap, n) => Array.from({ length: n }, (_, i) => start + i * gap);

test("hits during the countdown are ignored", () => {
  const s = new Session(3000);
  s.addHit(1000, -20); // countdown beep
  s.addHit(3100, -20);
  assert.equal(s.count, 1);
});

test("stops by itself after 5 s of silence, not before", () => {
  const s = new Session(0);
  for (const t of every(1000, 500, 10)) s.addHit(t, -20);
  const last = 1000 + 9 * 500;
  assert.equal(s.shouldAutoStop(last + AUTO_STOP_MS - 50), false);
  assert.equal(s.shouldAutoStop(last + AUTO_STOP_MS), true);
});

test("does not stop before the jumping starts", () => {
  const s = new Session(0);
  s.addHit(1000, -20);
  assert.equal(s.shouldAutoStop(60000), false);
});

test("manual stop drops the tap on the screen", () => {
  const hits = hitsAt([...every(1000, 500, 20), 11300]);
  assert.equal(trimTail(hits, 11500).length, 20);
});

test("manual stop drops footsteps after a pause", () => {
  // 40 jumps, stop jumping, 2 s later walk 4 steps to the phone, then press stop.
  const jumps = every(1000, 450, 40);
  const lastJump = jumps[jumps.length - 1];
  const steps = every(lastJump + 2000, 550, 4);
  const stopT = steps[steps.length - 1] + 900;
  assert.equal(trimTail(hitsAt([...jumps, ...steps]), stopT).length, 40);
});

test("manual stop keeps jumps after a trip in the middle", () => {
  const before = every(1000, 450, 30);
  const after = every(before[29] + 3000, 450, 20);
  const stopT = after[19] + 6000;
  assert.equal(trimTail(hitsAt([...before, ...after]), stopT).length, 50);
});

test("continue then stop manually keeps both parts", () => {
  const s = new Session(0);
  for (const t of every(1000, 450, 50)) s.addHit(t, -20);
  s.resume(40000);
  for (const t of every(40400, 450, 11)) s.addHit(t, -20);
  s.stopManually(40400 + 10 * 450 + 1000);
  assert.equal(s.count, 61);
});

test("result: count, duration and jumps per minute", () => {
  const r = summarize(hitsAt(every(0, 500, 11)));
  assert.deepEqual(r, { count: 11, durationMs: 5000, perMinute: 120 });
});

test("a trip does not lower jumps per minute", () => {
  const r = summarize(hitsAt([...every(0, 500, 20), ...every(9500 + 4000, 500, 20)]));
  assert.equal(r.perMinute, 120);
});

test("full workout: detector + session, footsteps after auto-stop are not counted", () => {
  const SR = 48000;
  const { samples, jumpTimesMs } = makeJumpAudio({
    sampleRate: SR,
    segments: [{ jumps: 30, intervalMs: 450 }, { pauseMs: 2500 }, { jumps: 20, intervalMs: 450 }],
    tailMs: 12000,
    footstepsAfterMs: 6000,
  });
  const det = new HitDetector(SR);
  const session = new Session(500);
  let stoppedAt = null;
  for (let i = 0; i < samples.length && stoppedAt === null; i += 128) {
    const t = (i / SR) * 1000;
    for (const h of det.process(samples.subarray(i, i + 128), t)) session.addHit(h.t, h.db);
    if (session.shouldAutoStop(t)) stoppedAt = t;
  }
  assert.ok(stoppedAt !== null, "should stop by itself");
  assert.equal(session.result().count, jumpTimesMs.length);
  const lastJump = jumpTimesMs[jumpTimesMs.length - 1];
  assert.ok(stoppedAt - lastJump < AUTO_STOP_MS + 200, `stopped ${stoppedAt - lastJump} ms after last jump`);
});
