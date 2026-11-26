#!/usr/bin/env python3
"""
Local neural semantic embedding sidecar for Rufus v2 Core.
Uses the base sentence-transformers/paraphrase-MiniLM-L3-v2 (~60MB, already cached by SetFit)
to turn real-world events into normalized semantic vectors in milliseconds.
"""
import json
import os
import sys

BASE_MODEL = os.environ.get("RUFUS_EMBED_MODEL", "sentence-transformers/paraphrase-MiniLM-L3-v2")


def main() -> None:
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(BASE_MODEL)
    sys.stdout.write(json.dumps({"ready": True, "model": BASE_MODEL}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            texts = req.get("texts") or []
            if not isinstance(texts, list):
                texts = [str(texts)]
            texts = [str(t) for t in texts]
            if not texts:
                out = {"vectors": []}
            else:
                vecs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
                out = {"vectors": [[round(float(x), 6) for x in v] for v in vecs]}
        except Exception as e:
            out = {"error": str(e)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
