/**
 * Band-limited (windowed-sinc, polyphase) resampler.
 *
 * The classifier runs at 16 kHz while consoles run at 44.1/48/96 kHz.
 * Plain linear interpolation aliases cymbal/hi-hat energy above 8 kHz back
 * into the band the model listens to, so this low-passes properly first.
 * Kernels are precomputed per fractional phase, so the inner loop is just
 * multiply-adds (no trig), which keeps a 32-channel x 10 s pass well under
 * a second.
 */

const ZERO_CROSSINGS = 10;
const MAX_PHASES = 1024;

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function blackman(x) {
  // x in [-1, 1]
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

const kernelCache = new Map();

function buildKernels(fromRate, toRate) {
  const cacheKey = `${fromRate}:${toRate}`;
  if (kernelCache.has(cacheKey)) return kernelCache.get(cacheKey);

  const ratio = toRate / fromRate;
  // Cutoff relative to the input Nyquist; a little below the output Nyquist
  // when downsampling so the transition band doesn't alias.
  const cutoff = Math.min(1, ratio) * 0.94;
  const halfWidth = Math.ceil(ZERO_CROSSINGS / cutoff);
  const taps = 2 * halfWidth;
  const g = gcd(fromRate, toRate);
  const phases = Math.min(MAX_PHASES, toRate / g);

  const kernels = [];
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    const k = new Float32Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      // Tap j sits at input offset (j - halfWidth + 1) relative to floor(t).
      const x = j - halfWidth + 1 - frac;
      const w = Math.abs(x) >= halfWidth ? 0 : blackman(x / halfWidth);
      const arg = Math.PI * cutoff * x;
      const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
      k[j] = cutoff * sinc * w;
      sum += k[j];
    }
    // Normalise each phase to unity DC gain.
    for (let j = 0; j < taps; j++) k[j] /= sum;
    kernels.push(k);
  }
  const result = { kernels, phases, halfWidth, taps };
  kernelCache.set(cacheKey, result);
  return result;
}

/**
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const { kernels, phases, halfWidth, taps } = buildKernels(fromRate, toRate);
  const outLength = Math.floor((input.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const n = input.length;
  const step = fromRate / toRate;

  for (let i = 0; i < outLength; i++) {
    const t = i * step;
    const i0 = Math.floor(t);
    let phase = Math.round((t - i0) * phases);
    let base = i0 - halfWidth + 1;
    if (phase === phases) { phase = 0; base += 1; }
    const k = kernels[phase];
    let acc = 0;
    if (base >= 0 && base + taps <= n) {
      for (let j = 0; j < taps; j++) acc += k[j] * input[base + j];
    } else {
      for (let j = 0; j < taps; j++) {
        const idx = base + j;
        if (idx >= 0 && idx < n) acc += k[j] * input[idx];
      }
    }
    out[i] = acc;
  }
  return out;
}

module.exports = { resample };
