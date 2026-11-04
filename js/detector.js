// Finds rope hits in microphone audio. Pure logic: no browser APIs, so it runs
// the same in the AudioWorklet and in Node tests.
//
// How it works (PLAN.md, decision 2):
// 1. A 4th-order high-pass filter keeps the sharp "crack" of the rope on the
//    floor and removes low sounds (foot thuds, AC hum, most of speech).
// 2. Every ~5 ms we measure the loudness (dB) of the filtered sound.
// 3. A hit is a sudden jump in loudness that is clearly above the quiet level
//    of the room, and not too soon after the previous hit.

const FRAME_MS = 5;
const HPF_HZ = 2500;
const RISE_DB = 8;            // loudness must jump this much within ~20 ms
const LOOKBACK_FRAMES = 4;    // compare with the quietest of the last 4 frames
const PEAK_WINDOW_MS = 30;    // after an onset, measure its peak for 30 ms
const ABS_MIN_DB = -70;       // never count anything quieter than this

// Room level = the 20th percentile of the last 2 s of frames, refreshed every
// 50 ms. Hits fill only a few frames, so they don't raise it. Unlike a slow
// running average, it can't get stuck if the mic starts with digital silence.
const FLOOR_WINDOW_FRAMES = 400;
const FLOOR_PERCENTILE = 0.2;
const FLOOR_EVERY_FRAMES = 10;
const FLOOR_MIN_DB = -100;

// Minimum time between two hits. Starts at 200 ms, then follows the jumper's
// rhythm: 40% of the median interval, kept between 150 and 300 ms. This stops
// the foot landing from being counted as a second hit.
const START_GAP_MS = 200;
const MIN_GAP_MS = 150;
const MAX_GAP_MS = 300;
const GAP_FACTOR = 0.4;
const RHYTHM_SIZE = 8;
const PAUSE_MS = 2000;        // intervals longer than this are pauses, not rhythm

export const SENSITIVITY_MIN = 1;
export const SENSITIVITY_MAX = 10;
export const SENSITIVITY_DEFAULT = 5;

// How far above the room level a hit must be. Sensitivity 1 → 19 dB,
// 5 → 13 dB, 10 → 5.5 dB (in practice 8 dB, because of RISE_DB).
// Fake-audio tests: 16 dB missed 2–6 of 50 hits in a noisy room, 13 dB missed none.
export function thresholdAboveFloorDb(sensitivity) {
  const s = clamp(sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
  return 19 - (s - 1) * 1.5;
}

// Once the rope's loudness is known, ignore sounds much quieter than it.
// Sensitivity 5 → 17 dB below the typical hit (13 dB dropped real hits when
// their loudness varied ±10 dB).
function belowPeakDb(sensitivity) {
  return 12 + clamp(sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
}

export function median(values) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// RBJ cookbook high-pass biquad (transposed direct form II).
class HighPass {
  constructor(sampleRate, freq, q) {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = 0;
    this.z2 = 0;
  }

  step(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export class HitDetector {
  constructor(sampleRate, { sensitivity = SENSITIVITY_DEFAULT } = {}) {
    this.sampleRate = sampleRate;
    this.sensitivity = sensitivity;
    this.frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
    // Two biquads with Butterworth Q values = one 4th-order Butterworth filter.
    this.hp1 = new HighPass(sampleRate, HPF_HZ, 0.5412);
    this.hp2 = new HighPass(sampleRate, HPF_HZ, 1.3066);
    this.acc = 0;
    this.n = 0;
    this.floorDb = null;
    this.ring = new Float32Array(FLOOR_WINDOW_FRAMES);
    this.ringLen = 0;
    this.ringPos = 0;
    this.frameNo = 0;
    this.history = [];
    this.lastDb = -120;
    this.lastThrDb = 0;
    this.resetSession();
  }

  setSensitivity(value) {
    this.sensitivity = clamp(Number(value) || SENSITIVITY_DEFAULT, SENSITIVITY_MIN, SENSITIVITY_MAX);
  }

  // Forget the rhythm (between workouts). The room level is kept.
  resetSession() {
    this.lastHitT = -Infinity;
    this.minGapMs = START_GAP_MS;
    this.intervals = [];
    this.peaks = [];
    this.pending = null;
  }

  thresholdDb() {
    let thr = Math.max(this.floorDb + thresholdAboveFloorDb(this.sensitivity), ABS_MIN_DB);
    if (this.peaks.length >= 4) {
      thr = Math.max(thr, median(this.peaks) - belowPeakDb(this.sensitivity));
    }
    return thr;
  }

  // samples: Float32Array block. startMs: time of the block's first sample.
  // Returns the hits whose peak finished measuring in this block: [{ t, db }].
  process(samples, startMs) {
    const hits = [];
    const msPerSample = 1000 / this.sampleRate;
    for (let i = 0; i < samples.length; i++) {
      const y = this.hp2.step(this.hp1.step(samples[i]));
      this.acc += y * y;
      this.n++;
      if (this.n === this.frameSize) {
        this.frame(this.acc / this.n, startMs + (i + 1) * msPerSample, hits);
        this.acc = 0;
        this.n = 0;
      }
    }
    return hits;
  }

  // Report a hit that is still measuring its peak (end of a test recording).
  flush() {
    if (!this.pending) return [];
    const hit = this.pending;
    this.pending = null;
    this.rememberPeak(hit.db);
    return [hit];
  }

  frame(power, t, hits) {
    const db = 10 * Math.log10(power + 1e-12);
    if (this.floorDb === null) this.floorDb = Math.max(db, FLOOR_MIN_DB);
    const thr = this.thresholdDb();

    if (this.pending) {
      this.pending.db = Math.max(this.pending.db, db);
      if (t - this.pending.t >= PEAK_WINDOW_MS) {
        hits.push(this.pending);
        this.rememberPeak(this.pending.db);
        this.pending = null;
      }
    } else {
      const recentMin = this.history.length ? Math.min(...this.history) : db;
      const gapOk = t - this.lastHitT >= this.minGapMs;
      if (db > thr && db - recentMin >= RISE_DB && gapOk) {
        this.onset(t);
        this.pending = { t, db };
      }
    }

    this.ring[this.ringPos] = db;
    this.ringPos = (this.ringPos + 1) % FLOOR_WINDOW_FRAMES;
    this.ringLen = Math.min(this.ringLen + 1, FLOOR_WINDOW_FRAMES);
    if (++this.frameNo % FLOOR_EVERY_FRAMES === 0) this.updateFloor();

    this.history.push(db);
    if (this.history.length > LOOKBACK_FRAMES) this.history.shift();
    this.lastDb = db;
    this.lastThrDb = thr;
  }

  onset(t) {
    const interval = t - this.lastHitT;
    if (interval < PAUSE_MS) {
      this.intervals.push(interval);
      if (this.intervals.length > RHYTHM_SIZE) this.intervals.shift();
      if (this.intervals.length >= 4) {
        this.minGapMs = clamp(GAP_FACTOR * median(this.intervals), MIN_GAP_MS, MAX_GAP_MS);
      }
    }
    this.lastHitT = t;
  }

  updateFloor() {
    const values = Array.from(this.ring.subarray(0, this.ringLen)).sort((a, b) => a - b);
    const p = values[Math.floor(FLOOR_PERCENTILE * (values.length - 1))];
    this.floorDb = Math.max(p, FLOOR_MIN_DB);
  }

  rememberPeak(db) {
    this.peaks.push(db);
    if (this.peaks.length > RHYTHM_SIZE) this.peaks.shift();
  }
}
