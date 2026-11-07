// The camera (F11): point the phone or laptop camera ahead, then
//  - "Check the crossing light": Chenxi's YOLOE detector reads the traffic
//    light every frame; a steady change is spoken (advisory only, never "safe");
//  - "Ask about what's around": Abdullah's voice assistant (Whisper → gemma3 with
//    his prompts and memory → Piper), by voice or typed.
// Both run in the local service (app/sidecar/server.py), so they work offline.
// Without it: online, questions go to Gemini with the same rules; offline, the
// sheet says how to start the service. Every answer passes makeSafe().

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callGemini, geminiText } from '../../net/gemini';
import { closeStream, createRecorder, grabFrame, openCamera, sharpestFrame } from '../../vision/camera';
import { createLightWatcher, SIGNAL_WORDS, type Signal } from '../../vision/lights';
import { makeSafe } from '../../vision/safety';
import { askAssistant, detectLights, sidecarHealth, type Light, type SidecarHealth } from '../../vision/sidecar';
import { Icon } from './Controls';
import { Modal } from './Dialogs';

const GEMINI_PROMPT =
  "You are a calm guide for a blind or low-vision person. The image is what their camera sees now. Answer their question in one or two short spoken sentences, plain words, no lists. Mention hazards first. Use left, right and ahead with rough distances. If the image is blurry, dark or does not show it, say so and say how to move the camera. If you cannot tell, say so. Never say whether it is safe to cross or to go: say you can't be relied on for safety.";

type SpeechCtor = new () => { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onerror: () => void; onend: () => void; start(): void; stop(): void };

export interface CameraSheetProps {
  open: boolean;
  onClose: () => void;
  /** Live region + device voice. */
  speak: (text: string) => void;
  /** Live region only (when Piper's own voice is playing). */
  announce: (text: string) => void;
  online: boolean;
  /** Start with the light check on (from a crossing). */
  startWithLight?: boolean;
}

export function CameraSheet(p: CameraSheetProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [health, setHealth] = useState<SidecarHealth | null>(null);
  const [checked, setChecked] = useState(false);
  const [watching, setWatching] = useState(false);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [boxes, setBoxes] = useState<Light[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<{ q: string; a: string; via: string } | null>(null);
  const recorder = useRef(createRecorder());
  const latest = useRef(p);
  latest.current = p;
  const watcher = useRef(createLightWatcher((s, sentence) => {
    setSignal(s);
    latest.current.speak(sentence);
  }));

  // Open the camera and look for the service while the sheet is open.
  useEffect(() => {
    if (!p.open) return;
    let cancelled = false;
    setCamError(null);
    setAnswer(null);
    watcher.current.reset();
    setSignal(null);
    const video = videoRef.current;
    if (video)
      openCamera(video)
        .then((s) => (cancelled ? closeStream(s) : (streamRef.current = s)))
        .catch((e: Error) => setCamError(e.name === 'NotAllowedError' ? 'Camera permission is off. Allow the camera for this page, then try again.' : `The camera did not open: ${e.message}`));
    const poll = async () => {
      const h = await sidecarHealth();
      if (cancelled) return;
      setHealth(h);
      setChecked(true);
    };
    void poll();
    const id = setInterval(poll, 5000);
    setWatching(!!p.startWithLight);
    return () => {
      cancelled = true;
      clearInterval(id);
      setWatching(false);
      closeStream(streamRef.current);
      streamRef.current = null;
    };
  }, [p.open, p.startWithLight]);

  // The light check: one frame at a time, as fast as the detector answers.
  useEffect(() => {
    if (!p.open || !watching) return;
    let stop = false;
    let darkSaid = false;
    (async () => {
      while (!stop) {
        const v = videoRef.current;
        const f = v ? grabFrame(v, 640, 0.8) : null;
        if (f && f.brightness < 25) {
          if (!darkSaid) latest.current.speak("It's very dark, or the camera is covered.");
          darkSaid = true;
        } else if (f) {
          darkSaid = false;
          try {
            const d = await detectLights(f.jpeg);
            if (stop) break;
            setBoxes(d.lights);
            watcher.current.feed(d);
          } catch {
            if (!stop) {
              latest.current.speak("The light check needs the camera service on this laptop. It isn't running.");
              setWatching(false);
            }
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return () => {
      stop = true;
      setBoxes([]);
    };
  }, [p.open, watching]);

  const toggleWatch = () => {
    if (!watching) {
      watcher.current.reset();
      setSignal(null);
      p.speak('Checking the light. Point the camera across the road, at head height.');
    } else p.speak('Light check off.');
    setWatching((w) => !w);
  };

  /** Ask by text or recorded audio. */
  const ask = async (q: { question?: string; audio?: string }) => {
    const v = videoRef.current;
    setBusy(true);
    try {
      const frame = v ? await sharpestFrame(v, 4, 120, 1920) : null;
      if (health?.assistant) {
        // Spoken by the app's speaker, in Abdullah's Piper voice like every other prompt.
        const r = await askAssistant({ ...q, image: frame?.jpeg ?? null, speak: false });
        const a = makeSafe(r.answer);
        setAnswer({ q: r.question || q.question || '', a, via: `${r.usedCamera ? 'Camera, ' : ''}${health.mock ? 'mock service' : health.model ?? 'local model'}` });
        p.speak(a);
        return;
      }
      if (!q.question) return p.speak("I couldn't hear that: speech needs the camera service. Type your question instead.");
      if (!p.online) return p.speak("Camera questions need the camera service on this laptop, or a connection. Neither is available.");
      const g = await callGemini({
        systemInstruction: { parts: [{ text: GEMINI_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: q.question }, ...(frame ? [{ inlineData: { mimeType: 'image/jpeg', data: frame.jpeg } }] : [])] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
      });
      const a = g.ok ? makeSafe(geminiText(g.data) ?? '') : '';
      if (!a) return p.speak(g.ok ? "Sorry, I couldn't work that out." : `The online model is not available: ${g.message}`);
      setAnswer({ q: q.question, a, via: 'Gemini, online' });
      p.speak(a);
    } catch (e) {
      p.speak(`Sorry, that didn't work: ${e instanceof Error ? e.message : String(e)}.`);
    } finally {
      setBusy(false);
    }
  };

  const talk = async () => {
    if (recording) {
      setRecording(false);
      const audio = await recorder.current.stop();
      if (!audio) return p.speak("I didn't hear anything. Try again, a little closer to the microphone.");
      return void ask({ audio });
    }
    // Without the service, use the browser's own speech recognition when it has one.
    if (!health?.speech) {
      const W = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
      const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
      if (!Ctor) return p.speak('Speech needs the camera service on this laptop. Type your question instead.');
      const rec = new Ctor();
      rec.lang = 'en-GB';
      rec.interimResults = false;
      setRecording(true);
      rec.onresult = (e) => void ask({ question: e.results[0][0].transcript });
      rec.onerror = () => p.speak("I couldn't hear that. Try again.");
      rec.onend = () => setRecording(false);
      rec.start();
      return;
    }
    try {
      await recorder.current.start();
      setRecording(true);
      p.announce('Listening. Press again when you have finished.');
    } catch {
      p.speak('The microphone did not open. Allow the microphone for this page.');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) void ask({ question: text.trim() });
  };

  const service = !checked
    ? 'Looking for the camera service…'
    : !health
      ? `Camera service not running on this laptop${p.online ? '. Questions go to Gemini online.' : '.'} Start it with: npm run sidecar`
      : health.mock
        ? 'Camera service in mock mode (fake answers, for testing).'
        : health.loading
          ? 'Camera service is loading its models…'
          : `On this laptop, offline: ${health.detector ? 'light check ready' : 'light check unavailable'}, ${health.assistant ? `assistant ${health.model}` : 'assistant unavailable'}.`;

  return (
    <Modal open={p.open} onClose={p.onClose} className="camera" labelledBy="cam-h">
      <div className="sheet-body">
        <div className="card-head">
          <h2 id="cam-h" style={{ flex: 1 }}>
            Camera
          </h2>
          <button type="button" className="round-btn" aria-label="Close camera" onClick={p.onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="cam-view">
          <video ref={videoRef} aria-label="Camera view, for a sighted helper" />
          {boxes.map((b, i) => (
            <div
              key={i}
              className={`cam-box ${b.colour}`}
              aria-hidden="true"
              style={{ left: `${b.box[0] * 100}%`, top: `${b.box[1] * 100}%`, width: `${(b.box[2] - b.box[0]) * 100}%`, height: `${(b.box[3] - b.box[1]) * 100}%` }}
            />
          ))}
          {camError && (
            <p className="cam-error" role="alert">
              <Icon name="videocam_off" /> {camError}
            </p>
          )}
        </div>

        {watching && (
          <div className={`signal ${signal ?? 'waiting'}`} aria-hidden="true">
            <Icon name="traffic" />
            <span>{signal ? SIGNAL_WORDS[signal] : 'Looking…'}</span>
          </div>
        )}

        <div className="btn-row">
          <button type="button" className={`btn big grow ${watching ? 'danger' : 'primary'}`} aria-pressed={watching} onClick={toggleWatch} disabled={!!camError}>
            <Icon name="traffic" />
            {watching ? 'Stop light check' : 'Check the crossing light'}
          </button>
        </div>

        <div className="btn-row">
          <button type="button" className={`btn big grow ${recording ? 'danger' : 'outline'}`} aria-pressed={recording} onClick={talk} disabled={busy}>
            <Icon name="mic" />
            {recording ? 'Stop and ask' : busy ? 'Thinking…' : 'Ask about what’s around'}
          </button>
          <button type="button" className="btn outline big" onClick={() => void ask({ question: 'What is in front of me?' })} disabled={busy || !!camError}>
            <Icon name="visibility" />
            What’s ahead?
          </button>
        </div>

        <form className="searchbar" onSubmit={submit} style={{ boxShadow: 'none', border: '2px solid #8a8a8a' }}>
          <label htmlFor="cam-q" className="visually-hidden">
            Type a question about what the camera sees
          </label>
          <input id="cam-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type: what does the sign say?" autoComplete="off" />
          <button type="submit" className="search-go" aria-label="Ask" disabled={busy}>
            <span className="search-go-text">Ask</span>
            <Icon name="question_answer" />
          </button>
        </form>

        {answer && (
          <div className="cam-answer">
            <p className="row-meta">{answer.q}</p>
            <p className="answer-text" style={{ fontSize: 20 }}>
              {answer.a}
            </p>
            <p className="fine">{answer.via}. Camera answers can be wrong, especially small text: check anything important with a person.</p>
          </div>
        )}

        <p className="fine">
          A guide only. It never tells you when it is safe to cross: use your cane or dog, listen to the traffic, and feel for the rotating cone under the push-button box. {service}
        </p>
      </div>
    </Modal>
  );
}
