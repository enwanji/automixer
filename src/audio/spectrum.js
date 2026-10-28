const { magnitudeSpectrum } = require('./fft');

const FFT_SIZE = 1024;
const HOP = 512;

/**
 * Fraction of a signal's energy below `cutoffHz`, averaged over frames
 * that are within 20 dB of the loudest one (so gaps between hits don't
 * count as "no low end").
 * @param {Float32Array} x
 * @param {number} sampleRate
 */
function lowEnergyRatio(x, sampleRate, cutoffHz = 100) {
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

  const frameEnergy = [];
  for (let s = 0; s + FFT_SIZE <= x.length; s += HOP) {
    let e = 0;
    for (let i = 0; i < FFT_SIZE; i++) e += x[s + i] * x[s + i];
    frameEnergy.push(e);
  }
  if (!frameEnergy.length) return 0;
  const floor = Math.max(...frameEnergy) * 0.01;
  const cutoffBin = Math.floor((cutoffHz * FFT_SIZE) / sampleRate);

  let low = 0;
  let total = 0;
  const frame = new Float64Array(FFT_SIZE);
  frameEnergy.forEach((e, f) => {
    if (e < floor) return;
    const s = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = x[s + i] * window[i];
    const mag = magnitudeSpectrum(frame, FFT_SIZE);
    for (let k = 1; k < mag.length; k++) {
      const p = mag[k] * mag[k];
      total += p;
      if (k <= cutoffBin) low += p;
    }
  });
  return total > 0 ? low / total : 0;
}

module.exports = { lowEnergyRatio };
