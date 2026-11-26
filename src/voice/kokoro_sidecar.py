#!/usr/bin/env python3
"""
Persistent local Kokoro-82M neural TTS sidecar for Rufus v2 Core.
Loads kokoro-v1.0.int8.onnx + voices-v1.0.bin once (~1s) and synthesizes WAV clips
on demand over JSONL stdin/stdout (default voice: bm_daniel).
"""
import json
import os
import sys
import time
import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> None:
    tts_dir = os.environ.get("RUFUS_TTS_DIR", os.path.expanduser("~/.rufus-v2/tts"))
    model_path = os.path.join(tts_dir, "kokoro-v1.0.int8.onnx")
    voices_path = os.path.join(tts_dir, "voices-v1.0.bin")
    default_voice = os.environ.get("RUFUS_VOICE", "bm_daniel")
    default_lang = os.environ.get("RUFUS_VOICE_LANG", "en-gb")

    kokoro = Kokoro(model_path, voices_path)
    sys.stdout.write(json.dumps({"ready": True, "voice": default_voice, "lang": default_lang}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        t0 = time.time()
        try:
            req = json.loads(line)
            text = str(req.get("text", "")).strip()
            voice = str(req.get("voice") or default_voice)
            lang = str(req.get("lang") or ("en-gb" if voice.startswith("b") else "en-us") or default_lang)
            speed = float(req.get("speed") or 1.0)
            out_path = str(req.get("outPath", "")).strip()
            if not text or not out_path:
                raise ValueError("text and outPath are required")
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            sf.write(out_path, samples, sr)
            out = {
                "ok": True,
                "outPath": out_path,
                "voice": voice,
                "audioSeconds": round(len(samples) / sr, 2),
                "durationMs": round((time.time() - t0) * 1000, 1),
            }
        except Exception as e:
            out = {"ok": False, "error": str(e), "durationMs": round((time.time() - t0) * 1000, 1)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
