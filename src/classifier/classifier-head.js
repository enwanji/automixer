const fs = require('fs');

/**
 * Optional trained head (see training/train_head.py): linear-softmax, or an
 * MLP with ReLU between layers. Runs on the mean YAMNet embedding of a
 * channel's active patches.
 *
 * models/classifier-head.json:
 * {
 *   "classes": ["kick","snare", ...],          // preset keys
 *   "layers": [{ "w": [[...]], "b": [...] }],   // w is [out][in]
 *   "activation": "relu"
 * }
 */
class ClassifierHead {
  constructor(weightsPathOrObject) {
    this.model = typeof weightsPathOrObject === 'string'
      ? JSON.parse(fs.readFileSync(weightsPathOrObject, 'utf8'))
      : weightsPathOrObject;
    if (!this.model.classes || !this.model.layers || !this.model.layers.length) {
      throw new Error('ClassifierHead: weights file missing "classes" or "layers"');
    }
    this.layers = this.model.layers.map((l) => ({
      w: l.w.map((row) => Float32Array.from(row)),
      b: Float32Array.from(l.b),
    }));
  }

  static softmax(v) {
    let max = -Infinity;
    for (const x of v) if (x > max) max = x;
    const exps = v.map((x) => Math.exp(x - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((x) => x / sum);
  }

  /**
   * @param {Float32Array|number[]} embedding
   * @returns {Record<string, number>} probability per class
   */
  predict(embedding) {
    let x = embedding;
    this.layers.forEach((layer, li) => {
      const out = new Array(layer.w.length);
      for (let i = 0; i < layer.w.length; i++) {
        const row = layer.w[i];
        let sum = layer.b[i] || 0;
        for (let j = 0; j < row.length; j++) sum += row[j] * x[j];
        out[i] = li < this.layers.length - 1 ? Math.max(0, sum) : sum;
      }
      x = out;
    });
    const probs = ClassifierHead.softmax(x);
    const byClass = {};
    this.model.classes.forEach((c, i) => { byClass[c] = probs[i]; });
    return byClass;
  }
}

module.exports = { ClassifierHead };
