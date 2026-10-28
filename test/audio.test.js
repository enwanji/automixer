const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resample } = require('../src/audio/resample');
const { measureLevels } = require('../src/audio/levels');
const { magnitudeSpectrum } = require('../src/audio/fft');
const { lowEnergyRatio } = require('../src/audio/spectrum');
const { deinterleaveInto } = require('../src/audio/capture');
const { readWav, readWavMono } = require('../src/audio/wav');

const sine = (freq, rate, seconds, amp = 1) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

test('fft finds the bin of a sine', () => {
  const n = 1024;
  const frame = sine(16000 * (100 / n), 16000, n / 16000); // exactly bin 100
  const mag = magnitudeSpectrum(frame, n);
  const peak = mag.indexOf(Math.max(...mag));
  assert.equal(peak, 100);
});

test('resample keeps in-band tones and their level', () => {
  for (const from of [48000, 44100, 96000]) {
    const out = resample(sine(1000, from, 1, 0.5), from, 16000);
    assert.equal(out.length, 16000);
    const level = rms(out, 1000, 15000) * Math.SQRT2;
    assert.ok(Math.abs(level - 0.5) < 0.01, `${from}: amplitude ${level}`);
  }
});

test('resample removes content above the new Nyquist (no aliasing)', () => {
  const out = resample(sine(12000, 48000, 1, 0.5), 48000, 16000);
  const leak = rms(out, 1000, 15000) / (0.5 / Math.SQRT2);
  assert.ok(leak < 0.01, `12 kHz leaked through at ${(20 * Math.log10(leak)).toFixed(1)} dB`);
});

test('levels: silence has no signal', () => {
  const l = measureLevels(new Float32Array(48000), 48000);
  assert.equal(l.hasSignal, false);
});

test('levels: peak and average', () => {
  const x = sine(220, 48000, 2, 0.5); // -6 dBFS peak
  const l = measureLevels(x, 48000);
  assert.ok(Math.abs(l.peakDb + 6.02) < 0.05);
  assert.ok(Math.abs(l.activeRmsDb + 9.03) < 0.1);
  assert.equal(l.clipped, false);
});

test('levels: a short burst is judged on when it plays', () => {
  const x = new Float32Array(48000 * 10);
  x.set(sine(200, 48000, 1, 0.1), 48000 * 4);
  const l = measureLevels(x, 48000);
  assert.ok(l.hasSignal);
  assert.ok(l.activeFraction < 0.15);
  assert.ok(Math.abs(l.activeRmsDb + 23) < 0.5, `active rms ${l.activeRmsDb}`);
});

test('levels: clipping is detected', () => {
  const x = sine(100, 48000, 1, 1.5).map((v) => Math.max(-1, Math.min(1, v)));
  assert.ok(measureLevels(x, 48000).clipped);
});

test('lowEnergyRatio separates sub-bass from mids', () => {
  assert.ok(lowEnergyRatio(sine(60, 16000, 1), 16000) > 0.9);
  assert.ok(lowEnergyRatio(sine(1000, 16000, 1), 16000) < 0.01);
});

test('deinterleave handles buffers that are not 4-byte aligned', () => {
  const interleaved = Float32Array.from([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
  const backing = Buffer.alloc(interleaved.byteLength + 1);
  Buffer.from(interleaved.buffer).copy(backing, 1);
  const unaligned = backing.subarray(1); // byteOffset 1 — new Float32Array(unaligned.buffer, 1) would throw
  const targets = [new Float32Array(4), new Float32Array(4)];
  assert.equal(deinterleaveInto(unaligned, 2, targets, 1), 3);
  assert.deepEqual(Array.from(targets[0]).map((v) => +v.toFixed(3)), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(Array.from(targets[1]).map((v) => +v.toFixed(3)), [0, -0.1, -0.2, -0.3]);
  assert.equal(deinterleaveInto(unaligned, 2, targets, 4), 0, 'stops when full');
});

test('wav reader: 24-bit stereo and 32-bit float', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialld-wav-'));
  const write = (file, format, bits, channels, frames) => {
    const bytes = bits / 8;
    const data = Buffer.alloc(frames.length * channels * bytes);
    let o = 0;
    for (const frame of frames) {
      for (const v of frame) {
        if (format === 3) data.writeFloatLE(v, o);
        else data.writeIntLE(Math.round(v * 8388607), o, 3);
        o += bytes;
      }
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(44100, 24); h.writeUInt32LE(44100 * channels * bytes, 28); h.writeUInt16LE(channels * bytes, 32);
    h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(path.join(dir, file), Buffer.concat([h, data]));
  };
  write('a.wav', 1, 24, 2, [[0.5, -0.5], [0.25, 0.75]]);
  write('b.wav', 3, 32, 1, [[0.125], [-1]]);
  const a = readWav(path.join(dir, 'a.wav'));
  assert.equal(a.sampleRate, 44100);
  assert.ok(Math.abs(a.channels[1][1] - 0.75) < 1e-6);
  assert.deepEqual(Array.from(readWavMono(path.join(dir, 'a.wav')).pcm).map((v) => +v.toFixed(4)), [0, 0.5]);
  assert.deepEqual(Array.from(readWav(path.join(dir, 'b.wav')).channels[0]), [0.125, -1]);
  fs.rmSync(dir, { recursive: true, force: true });
});
