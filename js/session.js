// One workout: collects hits after the countdown, decides when to stop by
// itself, and computes the result. Pure logic, tested in Node.
// Times are in milliseconds of audio-clock time.

import { median } from "./detector.js";

export const AUTO_STOP_MS = 5000;        // silence that ends the workout
export const MIN_HITS_FOR_AUTO_STOP = 5; // don't stop before the jumping starts
const TOUCH_MS = 400;                    // tap on the screen when pressing "stop"
const TAIL_GAP_MIN_MS = 1500;
const TAIL_MAX_HITS = 10;
const TAIL_WINDOW_MS = 8000;

export class Session {
  constructor(startT) {
    this.startT = startT;
    this.hits = [];
  }

  // Continue the same workout after a stop (button "كمّل").
  resume(startT) {
    this.startT = startT;
  }

  addHit(t, db) {
    if (t < this.startT) return false;
    this.hits.push({ t, db });
    return true;
  }

  get count() {
    return this.hits.length;
  }

  shouldAutoStop(nowT) {
    if (this.hits.length < MIN_HITS_FOR_AUTO_STOP) return false;
    const lastT = this.hits[this.hits.length - 1].t;
    return nowT - lastT >= AUTO_STOP_MS && lastT >= this.startT;
  }

  // Manual stop: drop the sounds of walking to the phone and tapping it.
  // Only the part after the last "كمّل" is checked: the pause before
  // continuing is not "walking to the phone".
  stopManually(stopT) {
    const earlier = this.hits.filter((h) => h.t < this.startT);
    const current = this.hits.filter((h) => h.t >= this.startT);
    this.hits = earlier.concat(trimTail(current, stopT));
  }

  result() {
    return summarize(this.hits);
  }
}

export function intervalsOf(hits) {
  const out = [];
  for (let i = 1; i < hits.length; i++) out.push(hits[i].t - hits[i - 1].t);
  return out;
}

// Removes sounds that came after the jumping ended:
// - anything in the last 400 ms before "stop" (the finger tapping the screen);
// - a short burst of sounds (≤10, within the last 8 s) after a clear pause
//   (≥1.5 s and ≥3× the normal rhythm), like footsteps walking to the phone.
export function trimTail(hits, stopT) {
  let kept = hits.filter((h) => h.t <= stopT - TOUCH_MS);
  if (kept.length < 3) return kept;
  const rhythm = median(intervalsOf(kept));
  const bigGap = Math.max(TAIL_GAP_MIN_MS, 3 * rhythm);
  for (let i = kept.length - 1; i >= 1; i--) {
    if (kept[i].t - kept[i - 1].t >= bigGap) {
      const tail = kept.length - i;
      if (tail <= TAIL_MAX_HITS && stopT - kept[i].t <= TAIL_WINDOW_MS) kept = kept.slice(0, i);
      break;
    }
  }
  return kept;
}

// count, total time from first to last jump, and jumps per minute (from the
// typical gap between jumps, so pauses and trips don't lower it).
export function summarize(hits) {
  const count = hits.length;
  if (count === 0) return { count: 0, durationMs: 0, perMinute: 0 };
  const durationMs = hits[count - 1].t - hits[0].t;
  const gaps = intervalsOf(hits);
  const perMinute = gaps.length ? Math.round(60000 / median(gaps)) : 0;
  return { count, durationMs, perMinute };
}
