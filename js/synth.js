// Makes fake jump-rope audio: background noise, a sharp rope "crack" on the
// floor for every jump, and a low foot thud shortly after it. Used by the
// tests and by the page's demo mode (index.html?demo=1).

// Small seeded random generator, so every run makes the same sound.
export function seededRandom(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dbToAmp = (db) => Math.pow(10, db / 20);

// segments: list of { jumps, intervalMs }; a { pauseMs } entry adds a pause
// (a trip). Returns { samples, jumpTimesMs }.
export function makeJumpAudio({
  sampleRate = 48000,
  segments = [{ jumps: 50, intervalMs: 450 }],
  leadMs = 1000,
  tailMs = 7000,
  jitterMs = 15,
  noiseDb = -62,
  slapDb = -22,
  slapVarDb = 6,
  slapDecayMs = 12,
  thudDb = -14,
  thudHfDb = -40,
  thudDelayMs = 80,
  footstepsAfterMs = null,
  footstepDb = -30,
  seed = 1,
} = {}) {
  const rand = seededRandom(seed);
  const jumpTimesMs = [];
  let t = leadMs;
  for (const seg of segments) {
    if (seg.pauseMs) {
      t += seg.pauseMs;
      continue;
    }
    for (let j = 0; j < seg.jumps; j++) {
      jumpTimesMs.push(t + (rand() * 2 - 1) * jitterMs);
      t += seg.intervalMs;
    }
  }
  const totalMs = t + tailMs;
  const length = Math.ceil((totalMs * sampleRate) / 1000);
  const samples = new Float32Array(length);

  const noiseAmp = dbToAmp(noiseDb);
  for (let i = 0; i < length; i++) samples[i] += (rand() * 2 - 1) * noiseAmp * 1.7;

  const addBurst = (startMs, amp, decayMs, kind) => {
    const start = Math.round((startMs * sampleRate) / 1000);
    const len = Math.round((decayMs * 6 * sampleRate) / 1000);
    for (let k = 0; k < len && start + k < length; k++) {
      const env = Math.exp(-((k / sampleRate) * 1000) / decayMs);
      const sec = k / sampleRate;
      const v =
        kind === "noise"
          ? (rand() * 2 - 1) * 1.7
          : Math.sin(2 * Math.PI * 90 * sec) + 0.5 * Math.sin(2 * Math.PI * 180 * sec);
      samples[start + k] += v * amp * env;
    }
  };

  for (const jt of jumpTimesMs) {
    const slap = dbToAmp(slapDb + (rand() * 2 - 1) * slapVarDb);
    addBurst(jt, slap, slapDecayMs, "noise");
    addBurst(jt + thudDelayMs, dbToAmp(thudDb), 40, "tone");
    addBurst(jt + thudDelayMs, dbToAmp(thudHfDb), 8, "noise");
  }

  if (footstepsAfterMs !== null) {
    for (let ft = t + footstepsAfterMs; ft < totalMs - 300; ft += 550) {
      addBurst(ft, dbToAmp(footstepDb), 10, "noise");
      addBurst(ft, dbToAmp(thudDb), 40, "tone");
    }
  }

  for (let i = 0; i < length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i]));
  return { samples, jumpTimesMs };
}
