import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LosslessEvent, MessageSink } from '../types';
import { messageEvent } from '../events/ingest';
import type { KokoroTts } from './kokoro';

const execFileAsync = promisify(execFile);

export interface VoiceHandlerDeps {
  tts: KokoroTts;
  stt?: { command: string; args: string[] };
  onVoiceTurn: (event: LosslessEvent, voiceSink: MessageSink) => Promise<void>;
}

const VOICE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<title>Rufus — Live Voice</title>
<style>
  :root { color-scheme: dark; --bg: #070b14; --card: #0f172a; --blue: #38bdf8; --glow: rgba(56,189,248,0.38); --text: #e2e8f0; --muted: #94a3b8; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top, #0f1d38, var(--bg) 65%); color: var(--text); min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: 20px 16px; }
  header { width: 100%; max-width: 520px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
  h1 { font-size: 16px; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; color: var(--blue); }
  .pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(56,189,248,0.12); border: 1px solid rgba(56,189,248,0.3); color: var(--blue); }
  .orb-wrap { margin: 22px 0 14px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .orb { width: 148px; height: 148px; border-radius: 50%; border: 2px solid var(--blue); background: radial-gradient(circle at 35% 30%, #38bdf8, #0284c7 45%, #082f49 100%); box-shadow: 0 0 40px var(--glow); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: transform .15s, box-shadow .2s; -webkit-tap-highlight-color: transparent; }
  .orb:active { transform: scale(0.95); }
  .orb.listening { background: radial-gradient(circle at 35% 30%, #f43f5e, #be123c 55%, #4c0519 100%); border-color: #fb7185; box-shadow: 0 0 54px rgba(244,63,94,0.55); animation: pulse 1.2s infinite; }
  .orb.speaking { box-shadow: 0 0 60px rgba(56,189,248,0.75); animation: pulse 0.9s infinite; }
  @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
  .status { font-size: 13px; color: var(--muted); min-height: 18px; }
  .bar { width: 100%; max-width: 520px; display: flex; gap: 8px; margin: 10px 0 16px; }
  .bar input { flex: 1; background: var(--card); border: 1px solid #1e293b; border-radius: 12px; color: var(--text); padding: 11px 14px; font-size: 15px; outline: none; }
  .bar button { background: var(--blue); color: #041220; border: 0; border-radius: 12px; padding: 0 16px; font-weight: 600; font-size: 14px; cursor: pointer; }
  .log { width: 100%; max-width: 520px; flex: 1; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding-bottom: 24px; }
  .msg { padding: 11px 14px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; }
  .msg.you { background: #1e293b; align-self: flex-end; max-width: 86%; }
  .msg.rufus { background: rgba(56,189,248,0.1); border: 1px solid rgba(56,189,248,0.22); align-self: flex-start; max-width: 90%; }
</style>
</head>
<body>
  <header>
    <h1>Rufus · Voice</h1>
    <span class="pill" id="voiceBadge">Daniel (Kokoro)</span>
  </header>
  <div class="orb-wrap">
    <button class="orb" id="orb">Tap to Talk</button>
    <div class="status" id="status">Ready — tap orb to talk or barge in</div>
  </div>
  <form class="bar" id="textForm">
    <input id="textInput" placeholder="Or type to speak with Daniel..." autocomplete="off" />
    <button type="submit">Send</button>
  </form>
  <div class="log" id="log"></div>
<script>
  const orb = document.getElementById('orb');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const textForm = document.getElementById('textForm');
  const textInput = document.getElementById('textInput');
  const audioQueue = [];
  let currentAudio = null;
  let recorder = null;
  let chunks = [];
  let isRecording = false;

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    logEl.prepend(div);
  }

  function stopPlayback() {
    audioQueue.length = 0;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = '';
      currentAudio = null;
    }
    orb.classList.remove('speaking');
  }

  function playNext() {
    if (currentAudio || !audioQueue.length) return;
    const item = audioQueue.shift();
    const audio = new Audio(item.url);
    currentAudio = audio;
    orb.classList.add('speaking');
    statusEl.textContent = 'Speaking... (tap orb to interrupt)';
    audio.onended = audio.onerror = () => {
      currentAudio = null;
      if (audioQueue.length) playNext();
      else {
        orb.classList.remove('speaking');
        statusEl.textContent = 'Ready';
      }
    };
    audio.play().catch(() => { currentAudio = null; orb.classList.remove('speaking'); });
  }

  const es = new EventSource('/voice/events');
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'audio') {
      addMsg('rufus', msg.text);
      audioQueue.push(msg);
      playNext();
    } else if (msg.type === 'status') {
      if (!isRecording && !currentAudio) statusEl.textContent = msg.text;
    }
  };

  async function sendText(text) {
    if (!text.trim()) return;
    stopPlayback();
    addMsg('you', text);
    statusEl.textContent = 'Thinking...';
    await fetch('/voice/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  textForm.onsubmit = (e) => {
    e.preventDefault();
    const val = textInput.value;
    textInput.value = '';
    sendText(val);
  };

  orb.onclick = async () => {
    if (currentAudio) {
      stopPlayback();
    }
    if (isRecording && recorder) {
      isRecording = false;
      orb.classList.remove('listening');
      orb.textContent = 'Tap to Talk';
      statusEl.textContent = 'Transcribing...';
      recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const res = await fetch('/voice/audio', {
          method: 'POST',
          headers: { 'content-type': blob.type || 'audio/webm' },
          body: buf,
        });
        const data = await res.json().catch(() => ({}));
        if (data.transcript) addMsg('you', data.transcript);
        else statusEl.textContent = data.error || 'Could not transcribe audio';
      };
      recorder.start();
      isRecording = true;
      orb.classList.add('listening');
      orb.textContent = 'Listening...';
      statusEl.textContent = 'Tap again when done speaking';
    } catch (err) {
      statusEl.textContent = 'Mic unavailable (use HTTPS/localhost or type below)';
    }
  };
</script>
</body>
</html>`;

/**
 * Mounts Live Voice Call endpoints onto the shared Rufus HTTP server:
 * - GET  /voice           (mobile-friendly live voice UI with barge-in)
 * - GET  /voice/events    (SSE push for async Daniel audio clips & status)
 * - POST /voice/turn      (text turn -> ONE RPG stream -> async Kokoro bm_daniel audio)
 * - POST /voice/audio     (raw audio -> local STT -> ONE RPG stream -> async Kokoro audio)
 * - GET  /voice/clip/:id  (streams synthesized WAV audio)
 */
export function createVoiceHttpHandler(deps: VoiceHandlerDeps) {
  const clients = new Set<http.ServerResponse>();

  const broadcast = (payload: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        clients.delete(res);
      }
    }
  };

  const voiceSink: MessageSink = {
    send: async (text: string) => {
      const synth = await deps.tts.synthesize(text);
      if (synth.ok && synth.clipId) {
        // Fire-and-forget async playback: push clip URL to client immediately and return Receipt!
        broadcast({
          type: 'audio',
          clipId: synth.clipId,
          url: `/voice/clip/${synth.clipId}`,
          text,
          voice: synth.voice,
          audioSeconds: synth.audioSeconds,
        });
        return { messageId: `voice_${synth.clipId}` };
      }
      broadcast({ type: 'status', text: `TTS unavailable: ${synth.error ?? 'unknown'}` });
      return { messageId: `voice_text_${randomUUID().slice(0, 8)}` };
    },
  };

  async function transcribeBuffer(buf: Buffer, mime: string): Promise<string | undefined> {
    if (!deps.stt) return undefined;
    const ext = mime.includes('mp4') || mime.includes('m4a') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
    const tmp = path.join(os.tmpdir(), `rufus-in-${randomUUID().slice(0, 8)}${ext}`);
    try {
      await fs.writeFile(tmp, buf);
      const args = deps.stt.args.map((a) => a.replace(/\{path\}/g, tmp));
      const { stdout } = await execFileAsync(deps.stt.command, args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      return stdout.trim() || undefined;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> => {
    if (req.method === 'GET' && pathname === '/voice') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(VOICE_HTML);
      return true;
    }

    if (req.method === 'GET' && pathname === '/voice/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'status', text: `Connected · ${deps.tts.voice}` })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/voice/clip/')) {
      const id = pathname.slice('/voice/clip/'.length);
      const filePath = deps.tts.clipPath(id);
      try {
        const data = await fs.readFile(filePath);
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(data.length) });
        res.end(data);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'clip not found' }));
      }
      return true;
    }

    if (req.method === 'POST' && (pathname === '/voice/turn' || pathname === '/voice/audio')) {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= 12 * 1024 * 1024) chunks.push(c);
      });
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        let text = '';
        if (pathname === '/voice/turn') {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as { text?: string };
            text = String(parsed.text ?? '').trim();
          } catch {
            text = body.toString('utf8').trim();
          }
        } else {
          const transcript = await transcribeBuffer(body, String(req.headers['content-type'] ?? 'audio/webm')).catch(() => undefined);
          if (!transcript) {
            res.writeHead(422, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Could not transcribe audio (check STT config).' }));
            return;
          }
          text = transcript;
        }
        if (!text) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'empty input' }));
          return;
        }

        const ev = messageEvent({
          channel: 'voice',
          actor: 'owner',
          text,
          timestamp: new Date().toISOString(),
          metadata: { mode: 'voice_call' },
        });
        ev.kind = 'owner_direct';
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, eventId: ev.id, transcript: text }));
        broadcast({ type: 'status', text: 'Thinking...' });
        void deps.onVoiceTurn(ev, voiceSink)
          .catch((err) => broadcast({ type: 'status', text: `Error: ${(err as Error).message}` }))
          .finally(() => broadcast({ type: 'status', text: 'Ready' }));
      });
      return true;
    }

    return false;
  };
}
