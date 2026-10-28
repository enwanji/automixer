"""
Runs models/yamnet.onnx over a folder of labeled recordings and saves one
embedding per chunk for train_head.py.

Folder layout -- one subfolder per preset key from src/presets.js:

    data/
      kick/     *.wav / *.flac / *.aiff / *.mp3
      snare/
      vocal/
      ...

Recordings can be any length: each file is cut into --chunk-sec pieces and
silent pieces are skipped, so a whole multitrack stem is fine. Your own
console recordings (e.g. a virtual soundcheck) work far better than sample
packs, because the head learns your mics and room.

Each chunk is processed the way the app processes a channel: loudness-
normalized, run through YAMNet, and the embeddings of its active patches
averaged.

Usage:
    python extract_embeddings.py --data-dir ./data --output ./embeddings.npz
"""
import argparse
import os

import librosa
import numpy as np
import onnxruntime as ort
from tqdm import tqdm

SAMPLE_RATE = 16000
PATCH_HOP = 7680
PATCH_LEN = 15600
NORMALIZE_TO_RMS_DB = -20
SILENCE_DB = -60
AUDIO_EXTENSIONS = (".wav", ".flac", ".aiff", ".aif", ".mp3", ".ogg")


def chunk_embeddings(session, audio, chunk_samples):
    for start in range(0, max(1, len(audio) - chunk_samples // 2), chunk_samples):
        chunk = audio[start:start + chunk_samples]
        rms = np.sqrt(np.mean(chunk ** 2)) if len(chunk) else 0
        if rms <= 10 ** (SILENCE_DB / 20):
            continue
        gain = min(10 ** (NORMALIZE_TO_RMS_DB / 20) / rms, 0.99 / np.max(np.abs(chunk)))
        x = (chunk * gain).astype(np.float32)
        embeddings = session.run(["embeddings"], {"waveform": x})[0]
        patch_rms = np.array([
            np.sqrt(np.mean(x[p * PATCH_HOP:p * PATCH_HOP + PATCH_LEN] ** 2) + 1e-12)
            for p in range(len(embeddings))
        ])
        active = patch_rms >= patch_rms.max() * 0.1  # within 20 dB of the loudest patch
        yield embeddings[active].mean(axis=0)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--model", default=os.path.join(here, "..", "models", "yamnet.onnx"))
    parser.add_argument("--chunk-sec", type=float, default=3.0)
    parser.add_argument("--output", default="./embeddings.npz")
    args = parser.parse_args()

    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    classes = sorted(d for d in os.listdir(args.data_dir) if os.path.isdir(os.path.join(args.data_dir, d)))
    if not classes:
        raise SystemExit(f"No class subfolders found in {args.data_dir}")

    embeddings, labels = [], []
    chunk_samples = int(args.chunk_sec * SAMPLE_RATE)
    for class_name in classes:
        class_dir = os.path.join(args.data_dir, class_name)
        files = sorted(f for f in os.listdir(class_dir) if f.lower().endswith(AUDIO_EXTENSIONS))
        before = len(embeddings)
        for fname in tqdm(files, desc=f"{class_name:10s}"):
            try:
                audio, _ = librosa.load(os.path.join(class_dir, fname), sr=SAMPLE_RATE, mono=True)
            except Exception as e:  # unreadable file: skip it, keep going
                print(f"    skipping {fname}: {e}")
                continue
            for emb in chunk_embeddings(session, audio, chunk_samples):
                embeddings.append(emb)
                labels.append(class_name)
        print(f"  {class_name}: {len(files)} files -> {len(embeddings) - before} examples")

    if not embeddings:
        raise SystemExit("No embeddings extracted -- check your data folder and file formats.")
    embeddings = np.stack(embeddings)
    np.savez(args.output, embeddings=embeddings, labels=np.array(labels))
    print(f"Saved {embeddings.shape[0]} embeddings (dim={embeddings.shape[1]}) to {args.output}")


if __name__ == "__main__":
    main()
