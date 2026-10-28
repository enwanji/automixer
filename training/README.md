# Training (optional)

DIALLD works without any training: it maps YAMNet's built-in AudioSet
classes onto instruments ("zero-shot"). This folder is for two optional jobs:

1. **Regenerating the model**: `models/yamnet.onnx` is already included.
2. **Training a custom classifier head** on your own recordings, which
   noticeably improves accuracy for your mics, room and band, especially for
   telling drums apart from each other.

## Setup (Python 3.11)

TensorFlow 2.15 doesn't support newer Pythons, so use a 3.11 environment:

```
cd training
uv venv --python 3.11 .venv            # or: py -3.11 -m venv .venv
uv pip install -r requirements.txt     # or: .venv\Scripts\pip install -r requirements.txt
```

Activate it (`.venv\Scripts\activate` on Windows, `source .venv/bin/activate`
elsewhere) before running the scripts below.

## Regenerate the YAMNet model

```
python convert_yamnet_to_onnx.py
```

This downloads YAMNet, exports `../models/yamnet.onnx` plus
`../models/yamnet_class_map.csv`, and checks the ONNX output against
TensorFlow on a few test signals (it fails loudly if they differ).

## Train a custom head

### 1. Collect labeled recordings

One folder per instrument, named with the preset keys from `src/presets.js`:

```
data/
  kick/  snare/  tom/  hihat/  overhead/
  bass/  eguitar/  aguitar/
  vocal/  speech/  piano/  pad/  horn/
```

You don't need every class. Classes you leave out simply can't be predicted
by the head. Files can be any length (WAV/FLAC/AIFF/MP3). They're cut into
3-second chunks and silent chunks are skipped, so whole multitrack stems
from a virtual soundcheck are ideal. Aim for a few minutes per class from
several different shows or players. Your own console recordings will beat
sample packs.

### 2. Extract embeddings

```
python extract_embeddings.py --data-dir ./data --output ./embeddings.npz
```

### 3. Train

```
python train_head.py --embeddings ./embeddings.npz
```

This prints a validation report (once there are at least 5 chunks per class)
and writes `../models/classifier-head.json`. Add `--hidden-size 64` if the
linear head's validation accuracy is poor.

### 4. Use it

Restart DIALLD. It loads `models/classifier-head.json` automatically and
uses it instead of zero-shot detection. Delete the file to go back.

If two instruments keep getting confused, the fix is almost always more and
more varied recordings of those two classes, not a bigger model. Re-run
steps 2–3 and restart.
