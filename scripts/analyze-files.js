#!/usr/bin/env node
/**
 * Headless check of the recognizer: analyzes WAV files (one per channel)
 * and prints what DIALLD would recommend. If the folder has an
 * expected.json ({ "<file stem>": "<preset key>" }) it also scores accuracy.
 *
 *   node scripts/analyze-files.js <folder-or-wav> [...]
 */
const fs = require('fs');
const path = require('path');
const { Recognizer } = require('../src/classifier/recognizer');
const { readWavMono } = require('../src/audio/wav');
const { PRESETS } = require('../src/presets');

async function main() {
  const files = [];
  let expected = {};
  for (const arg of process.argv.slice(2)) {
    if (fs.statSync(arg).isDirectory()) {
      fs.readdirSync(arg).filter((f) => f.toLowerCase().endsWith('.wav')).sort()
        .forEach((f) => files.push(path.join(arg, f)));
      const exp = path.join(arg, 'expected.json');
      if (fs.existsSync(exp)) expected = { ...expected, ...JSON.parse(fs.readFileSync(exp, 'utf8')) };
    } else {
      files.push(arg);
    }
  }
  if (!files.length) throw new Error('usage: node scripts/analyze-files.js <folder-or-wav> [...]');

  const t0 = Date.now();
  const recognizer = new Recognizer({ modelDir: path.join(__dirname, '..', 'models'), presetKeys: Object.keys(PRESETS) });
  await recognizer.init();
  console.log(`model loaded in ${Date.now() - t0} ms (${recognizer.mode})\n`);

  let right = 0;
  let scored = 0;
  const t1 = Date.now();
  for (const file of files) {
    const stem = path.basename(file, path.extname(file));
    const { sampleRate, pcm } = readWavMono(file, 10);
    const r = await recognizer.analyze(pcm, sampleRate);
    const key = r.instrument ? r.instrument.key : null;
    let mark = '';
    if (stem in expected) {
      scored++;
      if (expected[stem] === key) { right++; mark = 'OK '; } else mark = `XX (want ${expected[stem]})`;
    }
    const alts = r.instrument ? r.instrument.alternatives.map((a) => `${a.key} ${(a.score * 100).toFixed(0)}%`).join(', ') : '';
    console.log(
      `${stem.padEnd(14)} ${String(key && PRESETS[key].label || (r.levels.hasSignal ? '(unrecognised)' : '(no signal)')).padEnd(22)}`
      + ` ${r.instrument ? (r.instrument.confidence * 100).toFixed(0).padStart(3) + '%' : '    '}`
      + ` pk ${r.levels.peakDb.toFixed(1)} dBFS`.padEnd(16)
      + ` ${mark.padEnd(16)} alt: ${alts.padEnd(32)} heard: ${r.heard.map((h) => `${h.name} ${h.score.toFixed(2)}`).join(', ')}`
    );
  }
  console.log(`\n${files.length} channels analyzed in ${Date.now() - t1} ms`);
  if (scored) console.log(`accuracy: ${right}/${scored}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
