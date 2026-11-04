// Page logic: microphone → detector (audio thread) → session → screen.
// States: idle → countdown → running → done (PLAN.md, decision 4).

import { Session, summarize } from "./session.js";
import { SENSITIVITY_DEFAULT, SENSITIVITY_MIN, SENSITIVITY_MAX } from "./detector.js";
import { makeJumpAudio } from "./synth.js";

const DEMO = new URLSearchParams(location.search).has("demo");
const SENSITIVITY_KEY = "jrc.sensitivity";
const COUNTDOWN_S = 3;
const GO_BEEP_S = 0.35;
const AFTER_GO_S = 0.25; // the "go" beep's echo must not count as a jump
const METER_MIN_DB = -90;
const METER_MAX_DB = -10;

const $ = (id) => document.getElementById(id);
const ui = {
  count: $("count"),
  status: $("status"),
  meter: $("meter"),
  meterFill: $("meter-fill"),
  meterThr: $("meter-thr"),
  result: $("result"),
  duration: $("r-duration"),
  rate: $("r-rate"),
  error: $("error"),
  start: $("start"),
  stop: $("stop"),
  resume: $("resume"),
  again: $("again"),
  copy: $("copy"),
  sensitivity: $("sensitivity"),
  sensitivityValue: $("sensitivity-value"),
  demoBadge: $("demo-badge"),
};

let ctx = null;
let detectorNode = null;
let demoSource = null;
let state = "idle";
let session = null;
let wakeLock = null;
let timers = [];
let sensitivity = loadSensitivity();

// ---------- settings ----------

function loadSensitivity() {
  const v = Number(localStorage.getItem(SENSITIVITY_KEY));
  return Number.isInteger(v) && v >= SENSITIVITY_MIN && v <= SENSITIVITY_MAX ? v : SENSITIVITY_DEFAULT;
}

function setSensitivity(v) {
  sensitivity = v;
  localStorage.setItem(SENSITIVITY_KEY, String(v));
  ui.sensitivity.value = String(v);
  ui.sensitivityValue.textContent = String(v);
  detectorNode?.port.postMessage({ type: "sensitivity", value: v });
}

// ---------- audio ----------

async function setUpAudio() {
  if (ctx && detectorNode) {
    if (ctx.state === "suspended") await ctx.resume();
    return;
  }
  // Created inside the button press, so the browser allows sound.
  ctx = new AudioContext({ latencyHint: "interactive" });
  try {
    await connectDetector();
  } catch (err) {
    // e.g. mic permission refused: start clean on the next try.
    ctx.close();
    ctx = null;
    detectorNode = null;
    throw err;
  }
}

async function connectDetector() {
  let source = null;
  if (!DEMO) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-mic-api");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Raw sound: these "improvements" would soften the rope's sharp hits.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    source = ctx.createMediaStreamSource(stream);
  }
  await ctx.audioWorklet.addModule("js/worklet.js");
  detectorNode = new AudioWorkletNode(ctx, "rope-detector", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { sensitivity },
  });
  detectorNode.port.onmessage = onDetectorMessage;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  detectorNode.connect(mute).connect(ctx.destination);
  source?.connect(detectorNode);
  if (ctx.state === "suspended") await ctx.resume();
}

function nowMs() {
  return ctx.currentTime * 1000;
}

function beep(atS, freq, durS, volume = 0.5) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, atS);
  gain.gain.exponentialRampToValueAtTime(volume, atS + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, atS + durS);
  osc.connect(gain).connect(ctx.destination);
  osc.start(atS);
  osc.stop(atS + durS + 0.05);
}

// Demo mode: plays fake jump sounds (30 jumps, a trip, 20 jumps, then
// footsteps) into the detector instead of the microphone. Expected count: 50.
// Like a real mic, the room noise starts at the countdown; jumps start 0.4 s
// after it ends.
function playDemo(atS, firstJumpS) {
  const { samples } = makeJumpAudio({
    sampleRate: ctx.sampleRate,
    segments: [{ jumps: 30, intervalMs: 450 }, { pauseMs: 2500 }, { jumps: 20, intervalMs: 450 }],
    leadMs: (firstJumpS - atS) * 1000,
    tailMs: 12000,
    footstepsAfterMs: 6500,
  });
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);
  demoSource = ctx.createBufferSource();
  demoSource.buffer = buffer;
  demoSource.connect(detectorNode);
  demoSource.start(atS);
}

function stopDemo() {
  if (!demoSource) return;
  try {
    demoSource.stop();
  } catch {
    // already stopped
  }
  demoSource = null;
}

// ---------- screen stays on ----------

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {
    // Not allowed (battery saver, etc.). The workout still works.
  }
}

function letScreenSleep() {
  wakeLock?.release();
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (state === "countdown" || state === "running")) {
    keepScreenOn();
  }
});

// ---------- workout ----------

// Run fn at an audio-clock time (ms).
function at(audioMs, fn) {
  timers.push(setTimeout(fn, Math.max(0, audioMs - nowMs())));
}

function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}

async function begin(resume) {
  hideError();
  try {
    await setUpAudio();
  } catch (err) {
    showMicError(err);
    return;
  }
  setState("countdown");
  keepScreenOn();

  const t0 = ctx.currentTime + 0.15;
  for (let i = 0; i < COUNTDOWN_S; i++) beep(t0 + i, 880, 0.12);
  const goS = t0 + COUNTDOWN_S;
  beep(goS, 1320, GO_BEEP_S);
  const startMs = (goS + GO_BEEP_S + AFTER_GO_S) * 1000;

  detectorNode.port.postMessage({ type: "reset", at: startMs });
  if (resume && session) session.resume(startMs);
  else session = new Session(startMs);
  if (DEMO) playDemo(t0, startMs / 1000 + 0.4);

  for (let i = 0; i < COUNTDOWN_S; i++) {
    at((t0 + i) * 1000, () => (ui.count.textContent = String(COUNTDOWN_S - i)));
  }
  ui.status.textContent = "استعد…";
  at(goS * 1000, () => {
    setState("running");
    renderCount();
    ui.status.textContent = "نطّ! وبعد آخر نطة اوقف مكانك 5 ثواني";
  });
}

function finish(manual) {
  if (manual) session.stopManually(nowMs());
  clearTimers();
  stopDemo();
  letScreenSleep();
  setState("done");
  // Two falling beeps: "finished". Played after counting stopped.
  const t = ctx.currentTime + 0.05;
  beep(t, 988, 0.15);
  beep(t + 0.2, 659, 0.3);
  renderCount();
  renderResult(session.result());
  ui.status.textContent = "خلصت 👏";
}

function cancelCountdown() {
  clearTimers();
  stopDemo();
  letScreenSleep();
  if (session && session.count > 0) {
    setState("done");
    renderCount();
    renderResult(session.result());
    ui.status.textContent = "خلصت 👏";
  } else {
    session = null;
    setState("idle");
    ui.count.textContent = "0";
    ui.status.textContent = "حط الجوال على الأرض جنبك، واضغط ابدأ";
  }
}

function onDetectorMessage({ data }) {
  if (data.type === "hit") {
    if ((state === "countdown" || state === "running") && session.addHit(data.t, data.db)) {
      if (state === "running") renderCount();
    }
  } else if (data.type === "level") {
    renderMeter(data.db, data.thr);
    if (state === "running" && session.shouldAutoStop(data.t)) finish(false);
  }
}

// ---------- screen ----------

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  for (const el of document.querySelectorAll("[data-show]")) {
    el.hidden = !el.dataset.show.split(" ").includes(next);
  }
  ui.result.hidden = next !== "done";
  ui.meter.hidden = next === "idle" || !ctx;
}

function renderCount() {
  ui.count.textContent = String(session ? session.count : 0);
}

function renderResult({ durationMs, perMinute }) {
  const totalS = Math.round(durationMs / 1000);
  ui.duration.textContent = `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, "0")}`;
  ui.rate.textContent = String(perMinute);
}

function meterPercent(db) {
  const p = ((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
  return Math.max(0, Math.min(100, p));
}

function renderMeter(db, thr) {
  ui.meterFill.style.width = `${meterPercent(db)}%`;
  ui.meterThr.style.left = `${meterPercent(thr)}%`;
}

function showMicError(err) {
  const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
  ui.error.textContent = denied
    ? "الصفحة تحتاج إذن المايك عشان تسمع الحبل. اضغط على القفل جنب الرابط فوق، وفعّل المايك، وبعدين جرّب مرة ثانية."
    : `ما قدرت أشغّل المايك (${err?.name || err?.message || err}).`;
  ui.error.hidden = false;
  setState("idle");
}

function hideError() {
  ui.error.hidden = true;
}

// Copies the hit times so they can be pasted to Claude for tuning.
async function copyTuningData() {
  const hits = session?.hits ?? [];
  const first = hits.length ? hits[0].t : 0;
  const data = {
    v: 1,
    startOffsetMs: hits.length ? Math.round(first - session.startT) : null,
    demo: DEMO,
    sensitivity,
    result: summarize(hits),
    hits: hits.map((h) => [Math.round(h.t - first), Math.round(h.db)]),
  };
  const text = JSON.stringify(data);
  try {
    await navigator.clipboard.writeText(text);
    ui.copy.textContent = "انسخت ✓";
  } catch {
    ui.copy.textContent = "ما قدرت أنسخ";
  }
  setTimeout(() => (ui.copy.textContent = "نسخ بيانات الضبط"), 2500);
}

// ---------- buttons ----------

ui.start.addEventListener("click", () => begin(false));
ui.again.addEventListener("click", () => begin(false));
ui.resume.addEventListener("click", () => begin(true));
ui.stop.addEventListener("click", () => (state === "countdown" ? cancelCountdown() : finish(true)));
ui.copy.addEventListener("click", copyTuningData);
ui.sensitivity.addEventListener("input", () => setSensitivity(Number(ui.sensitivity.value)));

setSensitivity(sensitivity);
ui.demoBadge.hidden = !DEMO;
if (DEMO) window.jrcSession = () => session; // for checking the demo from dev tools
setState("idle");
