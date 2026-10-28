/**
 * Zero-shot instrument detection: YAMNet already outputs probabilities for
 * the 521 AudioSet classes, many of which are instruments. Each preset key
 * maps to the AudioSet classes that indicate it, with a weight for how
 * specific that evidence is (e.g. "Bass drum" is strong evidence for kick,
 * the generic "Drum" is weak evidence for either kick or tom).
 *
 * Negative weights are contrast terms: "Bass guitar" is a child of "Guitar"
 * in the AudioSet ontology, so when the generic "Guitar" score is about as
 * high as "Bass guitar" it's more likely a regular guitar.
 *
 * Names must match models/yamnet_class_map.csv exactly — test/ checks this.
 */
const AUDIOSET_EVIDENCE = {
  kick: { 'Bass drum': 1.0, 'Drum machine': 0.5, 'Drum': 0.35 },
  snare: { 'Snare drum': 1.0, 'Rimshot': 0.9, 'Drum roll': 0.5 },
  tom: { 'Drum': 0.6, 'Timpani': 0.8, 'Tabla': 0.5 },
  hihat: { 'Hi-hat': 1.0, 'Tambourine': 0.7, 'Maraca': 0.6, 'Cymbal': 0.45 },
  overhead: { 'Drum kit': 0.8, 'Cymbal': 0.8, 'Gong': 0.5 },
  bass: { 'Bass guitar': 1.0, 'Double bass': 0.8, 'Guitar': -0.25 },
  eguitar: {
    'Electric guitar': 1.0, 'Guitar': 0.6, 'Plucked string instrument': 0.4,
    'Steel guitar, slide guitar': 0.7, 'Tapping (guitar technique)': 0.6, 'Distortion': 0.6,
  },
  aguitar: {
    'Acoustic guitar': 1.0, 'Guitar': 0.6, 'Plucked string instrument': 0.4, 'Strum': 0.7,
    'Banjo': 0.8, 'Mandolin': 0.8, 'Ukulele': 0.8, 'Sitar': 0.6, 'Harp': 0.6,
  },
  vocal: {
    'Singing': 1.0, 'Choir': 0.9, 'Child singing': 0.9, 'Synthetic singing': 0.8, 'Rapping': 0.9,
    'Humming': 0.8, 'Yodeling': 0.8, 'A capella': 0.8, 'Vocal music': 0.6, 'Chant': 0.7,
  },
  speech: {
    'Speech': 1.0, 'Narration, monologue': 0.9, 'Conversation': 0.8, 'Child speech, kid speaking': 0.8,
  },
  piano: {
    'Piano': 1.0, 'Electric piano': 1.0, 'Keyboard (musical)': 0.7, 'Harpsichord': 0.8, 'Organ': 0.8,
    'Electronic organ': 0.8, 'Hammond organ': 0.8, 'Marimba, xylophone': 0.6, 'Vibraphone': 0.6,
    'Glockenspiel': 0.5, 'Accordion': 0.6,
  },
  pad: {
    'Synthesizer': 1.0, 'String section': 0.9, 'Bowed string instrument': 0.8, 'Violin, fiddle': 0.9,
    'Cello': 1.0, 'Orchestra': 0.6, 'Sampler': 0.5, 'Theremin': 0.5, 'Ambient music': 0.4,
  },
  horn: {
    'Brass instrument': 1.0, 'Trumpet': 1.0, 'Trombone': 1.0, 'French horn': 1.0, 'Saxophone': 1.0,
    'Wind instrument, woodwind instrument': 0.9, 'Flute': 0.9, 'Clarinet': 0.9, 'Harmonica': 0.8,
  },
};

/**
 * Resolves class names to indices once, so per-channel scoring is a few
 * dozen array lookups.
 * @param {string[]} classNames index -> AudioSet display name
 */
function compileEvidence(classNames) {
  const indexByName = new Map(classNames.map((n, i) => [n, i]));
  const compiled = {};
  const missing = [];
  for (const [key, evidence] of Object.entries(AUDIOSET_EVIDENCE)) {
    compiled[key] = [];
    for (const [name, weight] of Object.entries(evidence)) {
      if (indexByName.has(name)) compiled[key].push([indexByName.get(name), weight]);
      else missing.push(name);
    }
  }
  return { compiled, missing };
}

// Terms weaker than this are ignored so that instruments with many related
// AudioSet classes don't accumulate evidence from background noise.
const MIN_TERM = 0.02;

/**
 * Noisy-OR over positive evidence (several moderately confident classes
 * add up, e.g. "Guitar" + "Plucked string instrument" + "Acoustic guitar"),
 * minus contrast terms.
 * @param {Float32Array|number[]} classScores mean AudioSet scores for a channel
 * @param {object} compiled from compileEvidence()
 * @returns {Record<string, number>} raw evidence score per preset key (0..1)
 */
function scoreInstruments(classScores, compiled) {
  const out = {};
  for (const [key, evidence] of Object.entries(compiled)) {
    let notPresent = 1;
    let contrast = 0;
    for (const [idx, weight] of evidence) {
      const s = classScores[idx] * weight;
      if (weight < 0) contrast += s;
      else if (s >= MIN_TERM) notPresent *= 1 - s;
    }
    out[key] = Math.max(0, 1 - notPresent + contrast);
  }
  return out;
}

/**
 * Close-mic'd kicks are mostly energy below 100 Hz; snares, toms and
 * overheads aren't. When YAMNet hears "some drum" but can't say which,
 * this tips it towards kick. It never adds evidence on its own — without
 * drum evidence (e.g. a bass guitar) it does nothing.
 * @param {Record<string, number>} scores from scoreInstruments(), modified in place
 * @param {Float32Array|number[]} classScores
 * @param {string[]} classNames
 * @param {number} sub100Ratio fraction of the channel's energy below 100 Hz
 */
function applyLowEndPrior(scores, classScores, classNames, sub100Ratio) {
  const drumNames = ['Drum', 'Drum kit', 'Drum machine', 'Percussion', 'Bass drum'];
  let drumEvidence = 0;
  for (const name of drumNames) {
    const i = classNames.indexOf(name);
    if (i >= 0 && classScores[i] > drumEvidence) drumEvidence = classScores[i];
  }
  const lowEnd = Math.min(1, Math.max(0, (sub100Ratio - 0.4) / 0.2));
  if ('kick' in scores) scores.kick = Math.min(1, scores.kick + 0.5 * drumEvidence * lowEnd);
  return scores;
}

module.exports = { AUDIOSET_EVIDENCE, compileEvidence, scoreInstruments, applyLowEndPrior };
