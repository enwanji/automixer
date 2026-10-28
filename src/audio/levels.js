/**
 * Level measurement (for the level display, "no signal" detection and
 * loudness-normalizing the recognizer's input). Works on 50 ms blocks so that a
 * channel that only plays for part of the capture (a tom fill, a vocal
 * between lines) is judged on when it is actually playing.
 */

const BLOCK_SEC = 0.05;
const SILENCE_DB = -60;          // anything quieter is "no signal"
const ACTIVE_BELOW_LOUDEST_DB = 30;
const CLIP_LEVEL = 0.999;

function toDb(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

/**
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 */
function measureLevels(pcm, sampleRate) {
  const blockLen = Math.max(1, Math.round(BLOCK_SEC * sampleRate));
  const blockCount = Math.floor(pcm.length / blockLen);
  const blockRms = new Float32Array(blockCount);
  let peak = 0;
  let clippedSamples = 0;

  for (let b = 0; b < blockCount; b++) {
    let sumSq = 0;
    const start = b * blockLen;
    for (let i = start; i < start + blockLen; i++) {
      const v = pcm[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= CLIP_LEVEL) clippedSamples++;
      sumSq += v * v;
    }
    blockRms[b] = Math.sqrt(sumSq / blockLen);
  }

  let loudest = 0;
  for (let b = 0; b < blockCount; b++) if (blockRms[b] > loudest) loudest = blockRms[b];
  const gate = Math.max(
    Math.pow(10, SILENCE_DB / 20),
    loudest * Math.pow(10, -ACTIVE_BELOW_LOUDEST_DB / 20)
  );

  let activeBlocks = 0;
  let activeSumSq = 0;
  for (let b = 0; b < blockCount; b++) {
    if (blockRms[b] >= gate) {
      activeBlocks++;
      activeSumSq += blockRms[b] * blockRms[b];
    }
  }

  const peakDb = toDb(peak);
  const activeRmsDb = activeBlocks ? toDb(Math.sqrt(activeSumSq / activeBlocks)) : -Infinity;
  const activeFraction = blockCount ? activeBlocks / blockCount : 0;

  return {
    peakDb,
    activeRmsDb,
    activeFraction,
    clipped: clippedSamples >= 3,
    hasSignal: peakDb > SILENCE_DB && activeBlocks >= 2,
  };
}

module.exports = { measureLevels, toDb, SILENCE_DB };
