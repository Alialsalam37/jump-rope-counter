// Runs the detector on fake jump-rope audio and checks the count.
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { HitDetector } from "../js/detector.js";
import { makeJumpAudio } from "../js/synth.js";

const SR = 48000;

// Feed audio in 128-sample blocks, like the browser's AudioWorklet does.
function detect(samples, { sensitivity } = {}) {
  const det = new HitDetector(SR, { sensitivity });
  const hits = [];
  for (let i = 0; i < samples.length; i += 128) {
    const block = samples.subarray(i, i + 128);
    hits.push(...det.process(block, (i / SR) * 1000));
  }
  hits.push(...det.flush());
  return hits;
}

function count(options) {
  const { samples, jumpTimesMs } = makeJumpAudio({ sampleRate: SR, ...options });
  return { got: detect(samples).length, want: jumpTimesMs.length };
}

const cases = {
  "normal: 50 jumps, 450 ms apart (133/min)": {},
  "fast: 60 jumps, 300 ms apart (200/min)": { segments: [{ jumps: 60, intervalMs: 300 }] },
  "very fast: 60 jumps, 260 ms apart (230/min)": { segments: [{ jumps: 60, intervalMs: 260 }] },
  "slow: 30 jumps, 750 ms apart": { segments: [{ jumps: 30, intervalMs: 750 }] },
  "trip: 30 jumps, 2.5 s pause, 20 jumps": {
    segments: [{ jumps: 30, intervalMs: 450 }, { pauseMs: 2500 }, { jumps: 20, intervalMs: 450 }],
  },
  "speeding up: 20 at 600 ms, then 30 at 320 ms": {
    segments: [{ jumps: 20, intervalMs: 600 }, { jumps: 30, intervalMs: 320 }],
  },
  "echoey room: long ringing after each hit": { slapDecayMs: 60, segments: [{ jumps: 50, intervalMs: 350 }] },
  "noisy room: fan/AC noise 17 dB louder": { noiseDb: -45 },
  "quiet rope: hits 18 dB softer": { slapDb: -40, noiseDb: -66 },
  "loud shoes: foot landing has a sharp click too": { thudHfDb: -30 },
  "uneven hits: loudness varies ±10 dB": { slapVarDb: 10 },
};

for (const [name, options] of Object.entries(cases)) {
  test(name, () => {
    const { got, want } = count(options);
    assert.equal(got, want);
  });
}

test("mic that starts with 0.5 s of digital silence still counts right", () => {
  const { samples, jumpTimesMs } = makeJumpAudio({ sampleRate: SR });
  const padded = new Float32Array(SR / 2 + samples.length);
  padded.set(samples, SR / 2);
  // The jump from silence to room noise looks like a hit, but it happens during
  // the 3-second countdown, and Session ignores hits before the countdown ends.
  const afterCountdown = detect(padded).filter((h) => h.t >= 1000);
  assert.equal(afterCountdown.length, jumpTimesMs.length);
});

test("only background noise counts nothing", () => {
  const { samples } = makeJumpAudio({ sampleRate: SR, segments: [], tailMs: 10000, noiseDb: -50 });
  assert.equal(detect(samples).length, 0);
});

test("hit times match the real jump times (within 20 ms)", () => {
  const { samples, jumpTimesMs } = makeJumpAudio({ sampleRate: SR });
  const hits = detect(samples);
  assert.equal(hits.length, jumpTimesMs.length);
  hits.forEach((h, i) => assert.ok(Math.abs(h.t - jumpTimesMs[i]) < 20, `hit ${i}: ${h.t} vs ${jumpTimesMs[i]}`));
});
