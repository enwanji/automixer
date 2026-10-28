"""
Trains a small classifier head (logistic regression, or a 1-hidden-layer
MLP) on embeddings from extract_embeddings.py and exports it as
models/classifier-head.json, which the app picks up automatically on the
next start (and then uses instead of zero-shot detection).

Usage:
    python train_head.py --embeddings ./embeddings.npz
    python train_head.py --embeddings ./embeddings.npz --hidden-size 64
"""
import argparse
import json
import os
import re

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
MIN_PER_CLASS_FOR_VALIDATION = 5


def preset_keys():
    """Preset keys from src/presets.js, so class folders can be checked against them."""
    with open(os.path.join(HERE, "..", "src", "presets.js"), encoding="utf-8") as f:
        return re.findall(r"^  (\w+): \{$", f.read(), flags=re.M)


def export_logistic_regression(clf):
    return {
        "classes": list(clf.classes_),
        "activation": "relu",
        "layers": [{"w": clf.coef_.tolist(), "b": clf.intercept_.tolist()}],
    }


def export_mlp(clf):
    # sklearn stores weights as [n_in, n_out]; classifier-head.js expects [n_out, n_in].
    layers = [{"w": w.T.tolist(), "b": b.tolist()} for w, b in zip(clf.coefs_, clf.intercepts_)]
    return {"classes": list(clf.classes_), "activation": "relu", "layers": layers}


def make_classifier(hidden_size):
    if hidden_size <= 0:
        return LogisticRegression(max_iter=3000, C=1.0)
    return MLPClassifier(hidden_layer_sizes=(hidden_size,), activation="relu", alpha=1e-3,
                         max_iter=3000, random_state=42)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--embeddings", required=True)
    parser.add_argument("--output", default=os.path.join(HERE, "..", "models", "classifier-head.json"))
    parser.add_argument("--hidden-size", type=int, default=0,
                        help="0 = logistic regression (linear head), >0 = one hidden layer of this size")
    parser.add_argument("--test-size", type=float, default=0.2)
    args = parser.parse_args()

    data = np.load(args.embeddings, allow_pickle=True)
    X, y = data["embeddings"], data["labels"]
    classes, counts = np.unique(y, return_counts=True)
    print(f"Loaded {X.shape[0]} examples, {X.shape[1]}-d embeddings")
    for c, n in zip(classes, counts):
        print(f"  {c:10s} {n}")

    known = set(preset_keys())
    unknown = [c for c in classes if c not in known]
    if unknown:
        print(f"WARNING: these classes have no preset in src/presets.js and will be ignored by the app: {unknown}")

    if counts.min() >= MIN_PER_CLASS_FOR_VALIDATION and len(y) * args.test_size >= len(classes):
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=args.test_size, stratify=y, random_state=42)
        clf = make_classifier(args.hidden_size).fit(X_train, y_train)
        print("\nValidation on held-out examples:")
        print(classification_report(y_test, clf.predict(X_test), zero_division=0))
    else:
        print(f"\nToo few examples per class to hold some out for validation (need {MIN_PER_CLASS_FOR_VALIDATION}+); "
              "training on everything without a validation report.")

    # Final model uses all the data.
    clf = make_classifier(args.hidden_size).fit(X, y)
    exported = export_logistic_regression(clf) if args.hidden_size <= 0 else export_mlp(clf)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(exported, f)
    print(f"Saved head to {args.output} -- restart DIALLD to use it.")
    print("Delete that file to go back to zero-shot detection.")


if __name__ == "__main__":
    main()
