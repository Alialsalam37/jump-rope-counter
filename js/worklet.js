// Runs on the browser's audio thread. Feeds every block of microphone sound
// to the detector and sends hits (and a loudness level for the meter) to the page.

import { HitDetector, SENSITIVITY_DEFAULT } from "./detector.js";

const LEVEL_EVERY_MS = 50;

class RopeDetectorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sensitivity = options.processorOptions?.sensitivity ?? SENSITIVITY_DEFAULT;
    this.detector = new HitDetector(sampleRate, { sensitivity });
    this.lastLevelMs = -Infinity;
    this.resetAtMs = null;
    this.port.onmessage = ({ data }) => {
      if (data.type === "sensitivity") this.detector.setSensitivity(data.value);
      if (data.type === "reset") this.resetAtMs = data.at;
    };
  }

  process(inputs) {
    const nowMs = currentTime * 1000;
    // Forget the countdown beeps exactly when the workout starts.
    if (this.resetAtMs !== null && nowMs >= this.resetAtMs) {
      this.detector.resetSession();
      this.resetAtMs = null;
    }
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (const hit of this.detector.process(channel, nowMs)) {
        this.port.postMessage({ type: "hit", t: hit.t, db: hit.db });
      }
    }
    if (nowMs - this.lastLevelMs >= LEVEL_EVERY_MS) {
      this.lastLevelMs = nowMs;
      this.port.postMessage({
        type: "level",
        t: nowMs,
        db: this.detector.lastDb,
        thr: this.detector.lastThrDb,
      });
    }
    return true;
  }
}

registerProcessor("rope-detector", RopeDetectorProcessor);
