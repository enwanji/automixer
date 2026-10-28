const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AUDIOSET_EVIDENCE, compileEvidence, scoreInstruments, applyLowEndPrior } = require('../src/classifier/audioset-map');
const { ClassifierHead } = require('../src/classifier/classifier-head');
const { parseClassMap } = require('../src/classifier/yamnet');
const { Recognizer } = require('../src/classifier/recognizer');
const { PRESETS } = require('../src/presets');

const MODEL_DIR = path.join(__dirname, '..', 'models');
const haveModel = fs.existsSync(path.join(MODEL_DIR, 'yamnet.onnx'));
const classNames = haveModel ? parseClassMap(fs.readFileSync(path.join(MODEL_DIR, 'yamnet_class_map.csv'), 'utf8')) : null;

test('every preset has AudioSet evidence and vice versa', () => {
  assert.deepEqual(Object.keys(AUDIOSET_EVIDENCE).sort(), Object.keys(PRESETS).sort());
});

test('class map parses quoted names', { skip: !haveModel && 'model not converted' }, () => {
  assert.equal(classNames.length, 521);
  assert.equal(classNames[0], 'Speech');
  assert.ok(classNames.includes('Violin, fiddle'));
});

test('every AudioSet class name in the mapping exists', { skip: !haveModel && 'model not converted' }, () => {
  const { missing } = compileEvidence(classNames);
  assert.deepEqual(missing, []);
});

test('scoring: noisy-OR, contrast and minimum term', () => {
  const names = ['Bass guitar', 'Guitar', 'Electric guitar', 'Plucked string instrument', 'Drum', 'Bass drum'];
  const { compiled } = compileEvidence(names);
  const scores = (o) => names.map((n) => o[n] || 0);

  const bass = scoreInstruments(scores({ 'Bass guitar': 0.5, 'Guitar': 0.37, 'Plucked string instrument': 0.32 }), compiled);
  assert.ok(bass.bass > bass.eguitar, 'strong Bass guitar wins');

  const guitar = scoreInstruments(scores({ 'Bass guitar': 0.13, 'Guitar': 0.3, 'Electric guitar': 0.2 }), compiled);
  assert.ok(guitar.eguitar > guitar.bass, 'generic Guitar counts against bass');

  const weak = scoreInstruments(scores({ 'Electric guitar': 0.01 }), compiled);
  assert.equal(weak.eguitar, 0, 'terms below the noise floor are ignored');

  const both = scoreInstruments(scores({ 'Electric guitar': 0.5, 'Guitar': 0.5 }), compiled);
  assert.ok(both.eguitar > 0.5, 'evidence accumulates');
});

test('low-end prior only nudges kick when drums are heard', () => {
  const names = ['Drum', 'Bass guitar'];
  const drums = applyLowEndPrior({ kick: 0.1, tom: 0.2 }, [0.5, 0], names, 0.6);
  assert.ok(drums.kick > 0.3);
  assert.equal(drums.tom, 0.2);
  const bass = applyLowEndPrior({ kick: 0 }, [0, 0.8], names, 0.9);
  assert.equal(bass.kick, 0, 'no drum evidence, no nudge');
  const tom = applyLowEndPrior({ kick: 0.1 }, [0.5, 0], names, 0.35);
  assert.equal(tom.kick, 0.1, 'tom-like low end does not trigger it');
});

test('classifier head: linear and MLP', () => {
  const linear = new ClassifierHead({ classes: ['kick', 'vocal'], layers: [{ w: [[1, 0], [0, 1]], b: [0, 0] }] });
  const p = linear.predict([3, 0]);
  assert.ok(p.kick > 0.9 && Math.abs(p.kick + p.vocal - 1) < 1e-9);

  const mlp = new ClassifierHead({
    classes: ['a', 'b'], activation: 'relu',
    layers: [{ w: [[1, 0], [-1, 0]], b: [0, 0] }, { w: [[1, 0], [0, 1]], b: [0, 0] }],
  });
  assert.ok(mlp.predict([-5, 0]).b > 0.99, 'relu between layers');
  assert.throws(() => new ClassifierHead({ classes: ['a'] }), /missing/);
});

test('recognizer end to end on the real model', { skip: !haveModel && 'model not converted' }, async () => {
  const r = new Recognizer({ modelDir: MODEL_DIR, presetKeys: Object.keys(PRESETS) });
  await r.init();
  assert.equal(r.mode, 'zero-shot');

  const silent = await r.analyze(new Float32Array(48000 * 10), 48000);
  assert.equal(silent.instrument, null);
  assert.equal(silent.levels.hasSignal, false);

  // Speech-like harmonic tone with vibrato -- just checks shapes and timing.
  const sr = 48000;
  const x = Float32Array.from({ length: sr * 10 }, (_, i) => {
    const t = i / sr;
    const f0 = 220 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
    return 0.05 * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t));
  });
  const t0 = Date.now();
  const res = await r.analyze(x, sr);
  assert.ok(Date.now() - t0 < 2000, 'one 10 s channel analyzes in well under 2 s');
  assert.ok(res.levels.hasSignal);
  assert.ok(res.instrument && res.instrument.key in PRESETS);
  assert.ok(res.instrument.confidence >= 0 && res.instrument.confidence <= 1);
  assert.equal(res.heard.length, 3);
});

test('preset values fit the X32 parameter ranges', () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    assert.ok(p.hpf >= 20 && p.hpf <= 400, `${key} hpf`);
    assert.ok(p.eq.length <= 4, `${key} eq bands`);
    for (const b of p.eq) {
      assert.ok(b.f >= 20 && b.f <= 20000 && b.g >= -15 && b.g <= 15 && b.q >= 0.3 && b.q <= 10, `${key} eq`);
    }
    assert.ok(p.gate.thr >= -80 && p.gate.thr <= 0 && p.gate.range >= 3 && p.gate.range <= 60, `${key} gate`);
    assert.ok(p.comp.thr >= -60 && p.comp.thr <= 0 && p.comp.makeup >= 0 && p.comp.makeup <= 24, `${key} comp`);
  }
});
