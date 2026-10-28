/**
 * Runs models/yamnet.onnx (see training/convert_yamnet_to_onnx.py).
 * Input: mono 16 kHz waveform of any length. Output per 0.96 s patch
 * (0.48 s hop): 521 AudioSet scores and a 1024-d embedding.
 */
const fs = require('fs');

let ort = null;
let ortLoadError = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  ortLoadError = e;
}

const SAMPLE_RATE = 16000;
const PATCH_HOP_SAMPLES = 7680;   // 48 frames x 10 ms
const PATCH_SAMPLES = 15600;      // 96 frames x 10 ms + 25 ms window tail

function parseClassMap(csvText) {
  const lines = csvText.trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    // index,mid,display_name — display_name may be quoted and contain commas
    const m = line.match(/^\d+,[^,]*,(.*)$/);
    let name = m ? m[1] : line;
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/""/g, '"');
    return name;
  });
}

class Yamnet {
  constructor({ modelPath, classMapPath }) {
    this.modelPath = modelPath;
    this.classMapPath = classMapPath;
    this.session = null;
    this.classNames = [];
  }

  async load() {
    if (!ort) throw new Error(`onnxruntime-node failed to load (${ortLoadError && ortLoadError.message}). Run "npm install" again.`);
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Model not found at ${this.modelPath}. Run training/convert_yamnet_to_onnx.py (see training/README.md).`);
    }
    this.classNames = parseClassMap(fs.readFileSync(this.classMapPath, 'utf8'));
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    // First run pays for kernel setup; do it now rather than on the first capture.
    await this.run(new Float32Array(PATCH_SAMPLES));
  }

  /**
   * @param {Float32Array} waveform mono, 16 kHz
   * @returns {Promise<{scores: Float32Array[], embeddings: Float32Array[]}>}
   */
  async run(waveform) {
    const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', waveform, [waveform.length]) };
    const out = await this.session.run(feeds);
    const split = (t) => {
      const [rows, cols] = t.dims;
      return Array.from({ length: rows }, (_, r) => t.data.subarray(r * cols, (r + 1) * cols));
    };
    return { scores: split(out.scores), embeddings: split(out.embeddings) };
  }
}

module.exports = { Yamnet, parseClassMap, SAMPLE_RATE, PATCH_HOP_SAMPLES, PATCH_SAMPLES };
