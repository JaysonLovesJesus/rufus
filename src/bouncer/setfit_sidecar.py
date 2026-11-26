#!/usr/bin/env python3
"""
Local SetFit Bouncer sidecar for Rufus v2 Core.
- Sentence Transformer (paraphrase-MiniLM-L3-v2, ~60MB) + LogisticRegression classifier head.
- Trains on as few as 8-20 SLEEP/WAKE examples in ~20-30s on Apple Silicon.
- Serves persistent JSONL predictions over stdin/stdout in ~10ms at $0.
"""
import argparse
import json
import os
import sys
import time

BASE_MODEL = os.environ.get("RUFUS_SETFIT_BASE", "sentence-transformers/paraphrase-MiniLM-L3-v2")
LABEL_TO_ID = {"SLEEP": 0, "WAKE": 1}
ID_TO_LABEL = {0: "SLEEP", 1: "WAKE"}


def cmd_train(data_path: str, model_dir: str, epochs: int) -> None:
    from datasets import Dataset
    from setfit import SetFitModel, Trainer, TrainingArguments

    rows = []
    with open(data_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            lbl = item.get("label")
            txt = (item.get("text") or "").strip()
            if lbl in LABEL_TO_ID and txt:
                rows.append({"text": txt, "label": LABEL_TO_ID[lbl]})

    labels_present = {r["label"] for r in rows}
    if len(labels_present) < 2 or len(rows) < 6:
        print(json.dumps({"ok": False, "error": f"Need at least 6 examples spanning both SLEEP and WAKE (got {len(rows)})."}))
        sys.exit(1)

    t0 = time.time()
    ds = Dataset.from_list(rows)
    model = SetFitModel.from_pretrained(BASE_MODEL, labels=["SLEEP", "WAKE"])
    args = TrainingArguments(
        output_dir=os.path.join(model_dir, "_checkpoints"),
        batch_size=8,
        num_epochs=epochs,
        num_iterations=10,
        show_progress_bar=False,
        report_to="none",
    )
    trainer = Trainer(model=model, args=args, train_dataset=ds)
    trainer.train()
    os.makedirs(model_dir, exist_ok=True)
    model.save_pretrained(model_dir)
    print(json.dumps({"ok": True, "examples": len(rows), "seconds": round(time.time() - t0, 2), "modelDir": model_dir}))


def cmd_serve(model_dir: str) -> None:
    from setfit import SetFitModel

    model = SetFitModel.from_pretrained(model_dir)
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        t0 = time.time()
        try:
            req = json.loads(line)
            text = str(req.get("text", "")).strip()
            probs = model.predict_proba([text])[0]
            sleep_p = float(probs[0])
            wake_p = float(probs[1])
            label = "WAKE" if wake_p >= sleep_p else "SLEEP"
            conf = max(sleep_p, wake_p)
            out = {"label": label, "confidence": round(conf, 4), "durationMs": round((time.time() - t0) * 1000, 2)}
        except Exception as e:
            out = {"label": "WAKE", "confidence": 0.5, "error": str(e), "durationMs": round((time.time() - t0) * 1000, 2)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", required=True)
    t.add_argument("--model-dir", required=True)
    t.add_argument("--epochs", type=int, default=1)
    s = sub.add_parser("serve")
    s.add_argument("--model-dir", required=True)
    args = p.parse_args()
    if args.cmd == "train":
        cmd_train(args.data, args.model_dir, args.epochs)
    elif args.cmd == "serve":
        cmd_serve(args.model_dir)


if __name__ == "__main__":
    main()
