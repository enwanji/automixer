"""
Convert YAMNet (TF-Hub / Kaggle Models) into the ONNX model DIALLD runs at
runtime, plus its AudioSet class map.

The exported model takes a variable-length mono 16 kHz waveform and returns,
per ~0.96 s patch (0.48 s hop):

    scores      [patches, 521]   AudioSet class probabilities (used for
                                  zero-shot instrument detection)
    embeddings  [patches, 1024]  general-purpose embedding (used by an
                                  optional trained classifier head)

YAMNet computes its own log-mel front end inside the graph, so the app only
has to resample to 16 kHz -- there is no hand-rolled mel code to drift out
of sync with what the model was trained on.

Usage (Python 3.11, see requirements.txt):
    python convert_yamnet_to_onnx.py --output-dir ../models
"""
import argparse
import csv
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import tensorflow as tf
import tensorflow_hub as hub

YAMNET_HANDLE = "https://tfhub.dev/google/yamnet/1"


class YamnetScoresAndEmbeddings(tf.Module):
    def __init__(self, yamnet_model):
        super().__init__()
        self.yamnet_model = yamnet_model

    @tf.function(input_signature=[tf.TensorSpec(shape=[None], dtype=tf.float32, name="waveform")])
    def __call__(self, waveform):
        scores, embeddings, _spectrogram = self.yamnet_model(waveform)
        return {
            "scores": tf.identity(scores, name="scores"),
            "embeddings": tf.identity(embeddings, name="embeddings"),
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=os.path.join(os.path.dirname(__file__), "..", "models"))
    parser.add_argument("--opset", type=int, default=17)
    args = parser.parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    onnx_path = os.path.join(args.output_dir, "yamnet.onnx")
    class_map_path = os.path.join(args.output_dir, "yamnet_class_map.csv")

    print(f"Loading YAMNet from {YAMNET_HANDLE} ...")
    yamnet_model = hub.load(YAMNET_HANDLE)
    shutil.copyfile(yamnet_model.class_map_path().numpy().decode("utf-8"), class_map_path)
    with open(class_map_path, newline="") as f:
        n_classes = sum(1 for _ in csv.DictReader(f))
    print(f"Wrote class map ({n_classes} classes) to {class_map_path}")

    wrapped = YamnetScoresAndEmbeddings(yamnet_model)
    saved_model_dir = tempfile.mkdtemp(prefix="yamnet_saved_model_")
    try:
        tf.saved_model.save(wrapped, saved_model_dir, signatures=wrapped.__call__.get_concrete_function())
        print(f"Converting to ONNX (opset {args.opset}) ...")
        subprocess.run(
            [sys.executable, "-m", "tf2onnx.convert", "--saved-model", saved_model_dir,
             "--output", onnx_path, "--opset", str(args.opset)],
            check=True,
        )
    finally:
        shutil.rmtree(saved_model_dir, ignore_errors=True)

    verify(wrapped, onnx_path)
    print(f"Done: {onnx_path}")


def verify(wrapped, onnx_path):
    """Check the ONNX model reproduces TensorFlow's output on a few inputs."""
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    print("ONNX inputs:", [(i.name, i.shape) for i in session.get_inputs()])
    print("ONNX outputs:", [(o.name, o.shape) for o in session.get_outputs()])
    rng = np.random.default_rng(0)
    t = np.arange(16000 * 3) / 16000
    tests = {
        "noise 2s": (rng.standard_normal(32000) * 0.1).astype(np.float32),
        "sine 3s": (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32),
        "short 0.5s": (rng.standard_normal(8000) * 0.1).astype(np.float32),
    }
    output_names = [o.name for o in session.get_outputs()]
    for name, wav in tests.items():
        expected = wrapped(wav)
        got = dict(zip(output_names, session.run(None, {session.get_inputs()[0].name: wav})))
        for key in ("scores", "embeddings"):
            onnx_key = next(k for k in got if key in k)
            diff = np.max(np.abs(expected[key].numpy() - got[onnx_key]))
            print(f"  {name:10s} {key:10s} shape={got[onnx_key].shape} max|diff|={diff:.2e}")
            if diff > 1e-3:
                raise SystemExit(f"ONNX output for {key} differs from TensorFlow by {diff}")


if __name__ == "__main__":
    main()
