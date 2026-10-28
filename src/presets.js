/**
 * Processing presets, one per instrument the recognizer can output.
 * Keys are also the class-folder names used by training/ for a custom head.
 *
 * Units: Hz, dB, ms, Q. Gate/comp thresholds assume the channel peaks
 * around -12 dBFS. Every value can be edited per channel in the app.
 */
const PRESETS = {
  kick: {
    label: 'Kick Drum', family: 'drums', hpf: 30,
    eq: [{ f: 60, g: 3.5, q: 1.0 }, { f: 400, g: -4, q: 1.3 }, { f: 3500, g: 3, q: 0.7 }],
    gate: { on: true, thr: -32, range: 60, attack: 0.5, hold: 10, release: 120 },
    comp: { on: true, thr: -18, ratio: 4, attack: 5, release: 90, makeup: 3 },
  },
  snare: {
    label: 'Snare Drum', family: 'drums', hpf: 80,
    eq: [{ f: 200, g: 2, q: 1.0 }, { f: 900, g: -2, q: 1.2 }, { f: 5000, g: 3.5, q: 0.8 }],
    gate: { on: true, thr: -28, range: 40, attack: 0.5, hold: 8, release: 100 },
    comp: { on: true, thr: -16, ratio: 3, attack: 3, release: 70, makeup: 2.5 },
  },
  tom: {
    label: 'Tom', family: 'drums', hpf: 50,
    eq: [{ f: 100, g: 3, q: 1.0 }, { f: 450, g: -3, q: 1.2 }, { f: 4500, g: 2, q: 0.8 }],
    gate: { on: true, thr: -30, range: 50, attack: 0.5, hold: 10, release: 150 },
    comp: { on: true, thr: -17, ratio: 4, attack: 5, release: 90, makeup: 3 },
  },
  hihat: {
    label: 'Hi-Hat', family: 'drums', hpf: 300,
    eq: [{ f: 400, g: -3, q: 1.0 }, { f: 8000, g: 2.5, q: 0.7 }],
    gate: { on: false, thr: -40, range: 20, attack: 0.5, hold: 5, release: 60 },
    comp: { on: false, thr: -14, ratio: 2, attack: 2, release: 50, makeup: 0 },
  },
  overhead: {
    label: 'Overheads / Cymbals', family: 'drums', hpf: 120,
    eq: [{ f: 400, g: -2, q: 1.2 }, { f: 10000, g: 2, q: 0.7 }],
    gate: { on: false, thr: -50, range: 10, attack: 1, hold: 20, release: 200 },
    comp: { on: false, thr: -14, ratio: 2, attack: 10, release: 150, makeup: 0 },
  },
  bass: {
    label: 'Bass', family: 'bass', hpf: 35,
    eq: [{ f: 80, g: 2.5, q: 0.9 }, { f: 300, g: -2, q: 1.1 }, { f: 900, g: 1.5, q: 1.0 }],
    gate: { on: false, thr: -50, range: 15, attack: 1, hold: 20, release: 200 },
    comp: { on: true, thr: -20, ratio: 4, attack: 8, release: 120, makeup: 3 },
  },
  eguitar: {
    label: 'Electric Guitar', family: 'guitar', hpf: 90,
    eq: [{ f: 200, g: -2, q: 1.0 }, { f: 1200, g: 1.5, q: 1.0 }, { f: 3000, g: 2, q: 0.9 }],
    gate: { on: false, thr: -50, range: 20, attack: 0.5, hold: 15, release: 180 },
    comp: { on: false, thr: -19, ratio: 2, attack: 10, release: 100, makeup: 0 },
  },
  aguitar: {
    label: 'Acoustic Guitar', family: 'guitar', hpf: 100,
    eq: [{ f: 150, g: -1.5, q: 1.0 }, { f: 800, g: -1.5, q: 1.1 }, { f: 5000, g: 2.5, q: 0.8 }],
    gate: { on: false, thr: -50, range: 15, attack: 1, hold: 15, release: 200 },
    comp: { on: true, thr: -20, ratio: 3, attack: 7, release: 110, makeup: 2.5 },
  },
  vocal: {
    label: 'Vocal', family: 'vocal', hpf: 90,
    eq: [{ f: 250, g: -2, q: 1.1 }, { f: 3000, g: 2.5, q: 1.0 }, { f: 9000, g: 1.5, q: 0.7 }],
    gate: { on: false, thr: -50, range: 10, attack: 1, hold: 30, release: 250 },
    comp: { on: true, thr: -21, ratio: 3, attack: 10, release: 140, makeup: 4 },
  },
  speech: {
    label: 'Speech / MC', family: 'vocal', hpf: 120,
    eq: [{ f: 250, g: -2.5, q: 1.0 }, { f: 3000, g: 2, q: 1.0 }],
    gate: { on: false, thr: -50, range: 10, attack: 1, hold: 30, release: 250 },
    comp: { on: true, thr: -20, ratio: 3, attack: 10, release: 150, makeup: 3 },
  },
  piano: {
    label: 'Piano / Keys', family: 'keys', hpf: 40,
    eq: [{ f: 150, g: 1, q: 0.9 }, { f: 1000, g: -1, q: 1.0 }, { f: 6000, g: 1.5, q: 0.8 }],
    gate: { on: false, thr: -55, range: 10, attack: 1, hold: 25, release: 260 },
    comp: { on: true, thr: -22, ratio: 2, attack: 12, release: 150, makeup: 2 },
  },
  pad: {
    label: 'Synth / Pad / Strings', family: 'keys', hpf: 60,
    eq: [{ f: 200, g: -1, q: 0.8 }, { f: 2000, g: -1, q: 0.8 }, { f: 8000, g: 1, q: 0.7 }],
    gate: { on: false, thr: -55, range: 10, attack: 2, hold: 40, release: 300 },
    comp: { on: false, thr: -23, ratio: 2, attack: 15, release: 180, makeup: 0 },
  },
  horn: {
    label: 'Horns / Woodwind', family: 'horns', hpf: 100,
    eq: [{ f: 300, g: -1.5, q: 1.0 }, { f: 2500, g: 1.5, q: 1.0 }],
    gate: { on: false, thr: -50, range: 10, attack: 1, hold: 20, release: 200 },
    comp: { on: true, thr: -18, ratio: 2.5, attack: 10, release: 120, makeup: 2 },
  },
};

/** Compressor ratios the X32 offers; the preset editor picks from these. */
const COMP_RATIOS = [1.1, 1.3, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10, 20, 100];
const MAX_EQ_BANDS = 4;

/** Allowed range of every editable value (the X32's, the narrowest of the supported desks). */
const LIMITS = {
  hpf: [20, 400],
  eq: { f: [20, 20000], g: [-15, 15], q: [0.3, 10] },
  gate: { thr: [-80, 0], range: [3, 60], attack: [0, 120], hold: [0.02, 2000], release: [5, 4000] },
  comp: { thr: [-60, 0], ratio: [1.1, 100], attack: [0, 120], release: [5, 4000], makeup: [0, 24] },
};

function num(value, [min, max], name) {
  const v = Number(value);
  if (value === '' || value == null || typeof value === 'boolean' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return Math.max(min, Math.min(max, v));
}

/**
 * Checks a (possibly user-edited) preset and clamps every value into range.
 * @returns a clean copy; throws if something is missing or not a number
 */
function normalizePreset(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.eq) || !p.gate || !p.comp) throw new Error('preset is incomplete');
  if (p.eq.length > MAX_EQ_BANDS) throw new Error(`a preset has at most ${MAX_EQ_BANDS} EQ bands`);
  const section = (obj, limits, name) => Object.fromEntries(
    Object.entries(limits).map(([k, range]) => [k, num(obj[k], range, `${name} ${k}`)])
  );
  return {
    label: String(p.label || ''),
    family: String(p.family || ''),
    hpf: num(p.hpf, LIMITS.hpf, 'HPF'),
    eq: p.eq.map((b, n) => section(b, LIMITS.eq, `EQ band ${n + 1}`)),
    gate: { on: !!p.gate.on, ...section(p.gate, LIMITS.gate, 'gate') },
    comp: { on: !!p.comp.on, ...section(p.comp, LIMITS.comp, 'compressor') },
  };
}

module.exports = { PRESETS, COMP_RATIOS, MAX_EQ_BANDS, LIMITS, normalizePreset };
