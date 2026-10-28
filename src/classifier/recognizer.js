const fs = require('fs');
const path = require('path');
const { Yamnet, SAMPLE_RATE, PATCH_HOP_SAMPLES, PATCH_SAMPLES } = require('./yamnet');
const { ClassifierHead } = require('./classifier-head');
const { compileEvidence, scoreInstruments, applyLowEndPrior } = require('./audioset-map');
const { resample } = require('../audio/resample');
const { measureLevels } = require('../audio/levels');
const { lowEnergyRatio } = require('../audio/spectrum');

const NORMALIZE_TO_RMS_DB = -20;       // model input loudness, independent of console gain
const PATCH_ACTIVE_BELOW_LOUDEST_DB = 20;
const STRONG_EVIDENCE = 0.3;           // evidence at which confidence is no longer discounted

/**
 * Turns a channel's raw capture into an instrument recommendation.
 */
class Recognizer {
  constructor({ modelDir, presetKeys }) {
    this.modelDir = modelDir;
    this.presetKeys = presetKeys;
    this.yamnet = new Yamnet({
      modelPath: path.join(modelDir, 'yamnet.onnx'),
      classMapPath: path.join(modelDir, 'yamnet_class_map.csv'),
    });
    this.head = null;
    this.mode = null;
  }

  async init() {
    await this.yamnet.load();
    const { compiled, missing } = compileEvidence(this.yamnet.classNames);
    if (missing.length) console.warn('AudioSet classes not in class map:', missing);
    this.evidence = compiled;

    const headPath = path.join(this.modelDir, 'classifier-head.json');
    if (fs.existsSync(headPath)) {
      this.head = new ClassifierHead(headPath);
      const unknown = this.head.model.classes.filter((c) => !this.presetKeys.includes(c));
      if (unknown.length) console.warn('Trained head has classes with no preset (ignored):', unknown);
    }
    this.mode = this.head ? 'trained head' : 'zero-shot';
  }

  /**
   * @param {Float32Array} pcm
   * @param {number} sampleRate
   */
  async analyze(pcm, sampleRate) {
    const levels = measureLevels(pcm, sampleRate);
    if (!levels.hasSignal) return { levels, instrument: null, heard: [] };

    const x = resample(pcm, sampleRate, SAMPLE_RATE);
    normalizeInPlace(x, levels);

    const { scores, embeddings } = await this.yamnet.run(x);
    const active = activePatches(x, scores.length);
    const meanScores = meanOf(active.map((i) => scores[i]));

    let ranking;
    let confidence;
    if (this.head) {
      const probs = this.head.predict(meanOf(active.map((i) => embeddings[i])));
      ranking = this.presetKeys
        .filter((k) => k in probs)
        .map((key) => ({ key, score: probs[key] }));
      ranking.sort((a, b) => b.score - a.score);
      confidence = ranking[0].score;
    } else {
      const raw = scoreInstruments(meanScores, this.evidence);
      applyLowEndPrior(raw, meanScores, this.yamnet.classNames, lowEnergyRatio(x, SAMPLE_RATE, 100));
      const total = Object.values(raw).reduce((a, b) => a + b, 0);
      ranking = Object.entries(raw)
        .map(([key, s]) => ({ key, score: total > 0 ? s / total : 0, evidence: s }));
      ranking.sort((a, b) => b.score - a.score);
      const best = ranking[0];
      // Share of the evidence, discounted when the evidence itself is weak.
      confidence = best.score * Math.sqrt(Math.min(1, best.evidence / STRONG_EVIDENCE));
    }

    // Always offer a best guess — a low-confidence suggestion is quicker to
    // confirm or correct than an empty field.
    const best = ranking[0];
    return {
      levels,
      instrument: best && best.score > 0
        ? { key: best.key, confidence, alternatives: ranking.slice(1, 4).filter((r) => r.score > 0.05) }
        : { key: null, confidence: 0, alternatives: [] },
      heard: topClasses(meanScores, this.yamnet.classNames, 3),
    };
  }
}

/** Scales the model's copy to a fixed loudness so quiet channels aren't heard as "Silence". */
function normalizeInPlace(x, levels) {
  let gain = Math.pow(10, (NORMALIZE_TO_RMS_DB - levels.activeRmsDb) / 20);
  const peak = Math.pow(10, levels.peakDb / 20);
  gain = Math.min(gain, 0.99 / peak);
  for (let i = 0; i < x.length; i++) x[i] *= gain;
}

/** Indices of patches within 20 dB of the loudest one (skips the gaps between hits/phrases). */
function activePatches(x, patchCount) {
  const rms = [];
  for (let p = 0; p < patchCount; p++) {
    const start = p * PATCH_HOP_SAMPLES;
    const end = Math.min(x.length, start + PATCH_SAMPLES);
    let sum = 0;
    for (let i = start; i < end; i++) sum += x[i] * x[i];
    rms.push(end > start ? Math.sqrt(sum / (end - start)) : 0);
  }
  const loudest = Math.max(...rms);
  const floor = loudest * Math.pow(10, -PATCH_ACTIVE_BELOW_LOUDEST_DB / 20);
  const idx = rms.map((r, i) => (r >= floor && r > 0 ? i : -1)).filter((i) => i >= 0);
  return idx.length ? idx : rms.map((_, i) => i);
}

function meanOf(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}

function topClasses(scores, names, n) {
  return Array.from(scores, (s, i) => ({ name: names[i], score: s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

module.exports = { Recognizer, activePatches };
