/**
 * Minimal radix-2 Cooley-Tukey FFT, pure JS, no dependencies.
 * Operates in place on parallel real/imaginary Float64Array buffers.
 * Length must be a power of 2 — callers zero-pad to the next power of 2.
 */

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function bitReverseInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
}

function fftInPlace(re, im) {
  const n = re.length;
  if (!isPowerOfTwo(n)) {
    throw new Error(`fftInPlace: length ${n} is not a power of 2`);
  }
  bitReverseInPlace(re, im);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

/**
 * Real-valued magnitude spectrum of a windowed frame.
 * @param {Float32Array|Float64Array} frame - time-domain samples (already windowed)
 * @param {number} fftSize - power-of-2 FFT length (frame is zero-padded/truncated to this)
 * @returns {Float64Array} magnitude spectrum, length fftSize/2 + 1
 */
function magnitudeSpectrum(frame, fftSize) {
  if (!isPowerOfTwo(fftSize)) {
    throw new Error(`magnitudeSpectrum: fftSize ${fftSize} must be a power of 2`);
  }
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const n = Math.min(frame.length, fftSize);
  for (let i = 0; i < n; i++) re[i] = frame[i];
  fftInPlace(re, im);
  const half = fftSize / 2 + 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

module.exports = { fftInPlace, magnitudeSpectrum, isPowerOfTwo, nextPowerOfTwo };
