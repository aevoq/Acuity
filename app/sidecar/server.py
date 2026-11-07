"""
Local camera + voice service for the web app (runs on the laptop, offline).

It runs the team's Python work UNCHANGED, behind a tiny HTTP API on
http://127.0.0.1:8765 that the page calls:

  - Chenxi's traffic-light detector (Acuity/yolo_camera.py): YOLOE-26n finds
    objects, and traffic_light_colour() says which lamp is lit.
  - Abdullah's voice assistant (Abdullah/voice_assistant.py): faster-whisper
    hears the question, his routing decides whether it needs the camera
    (needs_camera / NEED_CAMERA), Ollama gemma3:4b answers with his prompts and
    conversation memory, Piper speaks.

The page sends camera frames and recorded audio; nothing leaves this machine.

  python app/sidecar/server.py            # real models
  SIDECAR_MOCK=1 python app/sidecar/server.py   # fake answers, to test the page without models

Endpoints (JSON in, JSON out):
  GET  /health                 what is loaded
  POST /vision/detect          {image: base64 jpeg} -> {lights: [{colour, confidence, box}], objects: [...], ms}
  POST /assistant/ask          {question? | audio: base64, image?: base64 jpeg, speak?: bool}
                               -> {question, answer, usedCamera, audio?: base64 wav}
  POST /voice/speak            {text} -> {audio: base64 wav}   Abdullah's Piper voice, for every
                               prompt in the app (cached by text)
"""

import ast
import base64
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CHENXI_FILE = os.path.join(REPO, "Acuity", "yolo_camera.py")
ABDULLAH_FILE = os.path.join(REPO, "Abdullah", "voice_assistant.py")
PORT = int(os.environ.get("SIDECAR_PORT", "8765"))
MOCK = os.environ.get("SIDECAR_MOCK") == "1"

state = {"detector": None, "detector_error": None, "assistant": None, "assistant_error": None,
         "whisper": None, "piper": False, "loading": True}
model_lock = threading.Lock()       # one YOLO inference at a time
assistant_lock = threading.Lock()   # one conversation turn at a time (shared history)


# =========================== Chenxi's detector, loaded from his file ===========================

def load_chenxi():
    """
    Chenxi's script opens the webcam and loops when imported, so we take only
    the definitions from it: its imports, its UPPERCASE settings (CLASSES,
    CONF, LIGHT_*) and its functions (traffic_light_colour). The detection
    code itself is his, read fresh from his file each start.
    """
    src = open(CHENXI_FILE, encoding="utf-8").read()
    tree = ast.parse(src, CHENXI_FILE)
    keep = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef)):
            keep.append(node)
        elif isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets):
            keep.append(node)
    ns = {"__name__": "chenxi_detector", "__file__": CHENXI_FILE}
    exec(compile(ast.Module(body=keep, type_ignores=[]), CHENXI_FILE, "exec"), ns)
    from ultralytics import YOLOE
    cwd = os.getcwd()
    os.chdir(os.path.dirname(CHENXI_FILE))   # weights download next to his script, as when he runs it
    try:
        model = YOLOE("yoloe-26n-seg.pt")
        model.set_classes(ns["CLASSES"])
    finally:
        os.chdir(cwd)
    return {"ns": ns, "model": model}


def detect(jpeg_bytes):
    import cv2
    import numpy as np
    frame = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Not a JPEG image")
    d = state["detector"]
    ns = d["ns"]
    t0 = time.time()
    with model_lock:
        r = d["model"].predict(frame, conf=ns.get("CONF", 0.25), verbose=False)[0]
    h, w = frame.shape[:2]
    lights, objects = [], []
    for cls, box, conf in zip(r.boxes.cls.tolist(), r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
        name = ns["CLASSES"][int(cls)]
        objects.append(name)
        if name == "traffic light":
            colour = ns["traffic_light_colour"](frame, box)
            x1, y1, x2, y2 = box
            lights.append({"colour": colour, "confidence": round(conf, 2), "box": [x1 / w, y1 / h, x2 / w, y2 / h]})
    brightness = float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean())
    return {"lights": lights, "objects": objects, "brightness": round(brightness), "ms": round((time.time() - t0) * 1000)}


# =========================== Abdullah's assistant, imported from his file ===========================

def load_abdullah():
    spec = importlib.util.spec_from_file_location("abdullah_voice_assistant", ABDULLAH_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)   # his main() only runs under __main__, so importing is safe
    return mod


def ask(question, image_bytes, want_audio):
    va = state["assistant"]
    import cv2
    import numpy as np
    with assistant_lock:
        n = va.normalise(question)
        if n in va.HELP_WORDS:
            answer, used_camera = va.HELP_TEXT, False
        elif n in va.REPEAT_WORDS and va.history:
            answer, used_camera = va.history[-1]["content"], False
        else:
            stop = threading.Event()
            spoken, used_camera = [], va.needs_camera(question)
            if not used_camera:
                sentences = va.stream_sentences(va.build_messages(va.TEXT_PROMPT, question), stop)
                first = next(sentences, None)
                if first is not None and "NEED_CAMERA" in first.upper():
                    used_camera = True
                    sentences.close()
                else:
                    spoken += [s for s in ([first] if first else []) + list(sentences)]
            if used_camera:
                if not image_bytes:
                    spoken = ["I can't see anything yet. Open the camera and point it where you want me to look."]
                else:
                    frame = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
                    if frame is None or float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean()) < va.DARK_FRAME_LEVEL:
                        spoken = ["It's very dark, or the camera might be covered. Could you turn on a light or point the camera somewhere else?"]
                    else:
                        spoken = list(va.stream_sentences(va.build_messages(va.CAMERA_PROMPT, question, image_bytes), stop))
            answer = va.clean_for_speech(" ".join(spoken)) or "Sorry, I had a problem working that out. Could you try again?"
            va.remember(question, answer)
    audio = None
    if want_audio and state["piper"]:
        path = os.path.join(tempfile.gettempdir(), f"sidecar-{time.time_ns()}.wav")
        if va.synth_to_file(answer, path):
            with open(path, "rb") as f:
                audio = base64.b64encode(f.read()).decode()
            os.remove(path)
    return {"question": question, "answer": answer, "usedCamera": used_camera, "audio": audio}


voice_cache = {}   # text -> base64 wav; prompts repeat ("Still on route...")


def speak_wav(text):
    """Abdullah's Piper voice for any text the app says. None when Piper isn't loaded."""
    text = " ".join(text.split())[:600]
    if text in voice_cache:
        return voice_cache[text]
    va = state["assistant"]
    if va is None or not state["piper"]:
        return None
    path = os.path.join(tempfile.gettempdir(), f"sidecar-say-{time.time_ns()}.wav")
    if not va.synth_to_file(va.clean_for_speech(text), path):
        return None
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    os.remove(path)
    if len(voice_cache) > 500:
        voice_cache.clear()
    voice_cache[text] = b64
    return b64


def transcribe(audio_bytes):
    """Browser audio (webm/ogg/wav) -> text, with Abdullah's Whisper settings."""
    from faster_whisper.audio import decode_audio
    va = state["assistant"]
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(audio_bytes)
        path = f.name
    try:
        return va.transcribe(state["whisper"], decode_audio(path, sampling_rate=va.SAMPLE_RATE))
    finally:
        os.remove(path)


# =========================== mock mode (no models) ===========================

def mock_detect(_):
    t = int(time.time() // 4) % 3
    colour = ["red", "green", "unknown"][t]
    return {"lights": [] if colour == "unknown" else [{"colour": colour, "confidence": 0.71, "box": [0.4, 0.1, 0.5, 0.4]}],
            "objects": ["person", "traffic light", "crosswalk"], "brightness": 120, "ms": 40, "mock": True}


def mock_ask(question, image_bytes, _):
    q = question or "(spoken question)"
    cam = any(w in q.lower() for w in ("front", "see", "around", "sign", "door", "ahead"))
    a = ("Mock answer: a pavement ahead with a crossing about five metres away, slightly left." if cam
         else "Mock answer: I'm the camera guide's stand-in. Start the real service to get real answers.")
    if cam and not image_bytes:
        a = "I can't see anything yet. Open the camera and point it where you want me to look."
    return {"question": q, "answer": a, "usedCamera": cam, "audio": None, "mock": True}


# =========================== start-up ===========================

def load_everything():
    if MOCK:
        state["loading"] = False
        print("Mock mode: no models loaded.")
        return
    try:
        print("Loading Chenxi's YOLOE detector…")
        state["detector"] = load_chenxi()
        print("  detector ready")
    except Exception as e:
        state["detector_error"] = f"{type(e).__name__}: {e}"
        print("  detector failed:", state["detector_error"])
    try:
        print("Loading Abdullah's assistant…")
        va = load_abdullah()
        state["assistant"] = va
        state["whisper"] = va.load_whisper()
        va.load_voice()
        state["piper"] = True
        threading.Thread(target=va.warm_up_model, daemon=True).start()
        print("  assistant ready (model:", va.VISION_MODEL, ")")
    except Exception as e:
        state["assistant_error"] = f"{type(e).__name__}: {e}"
        print("  assistant failed:", state["assistant_error"])
    state["loading"] = False


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")   # localhost only (bound to 127.0.0.1)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {
                "mock": MOCK, "loading": state["loading"],
                "detector": MOCK or state["detector"] is not None, "detectorError": state["detector_error"],
                "assistant": MOCK or state["assistant"] is not None, "assistantError": state["assistant_error"],
                "speech": MOCK or state["whisper"] is not None, "voice": state["piper"],
                "model": getattr(state["assistant"], "VISION_MODEL", None),
            })
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 20_000_000:
                return self._send(413, {"error": "too large"})
            body = json.loads(self.rfile.read(n) or b"{}")
            image = base64.b64decode(body["image"]) if body.get("image") else None
            if self.path.startswith("/vision/detect"):
                if not image:
                    return self._send(400, {"error": "image required"})
                if MOCK:
                    return self._send(200, mock_detect(image))
                if state["detector"] is None:
                    return self._send(503, {"error": state["detector_error"] or "detector still loading"})
                return self._send(200, detect(image))
            if self.path.startswith("/voice/speak"):
                text = (body.get("text") or "").strip()
                if not text:
                    return self._send(400, {"error": "text required"})
                if MOCK:
                    return self._send(503, {"error": "no voice in mock mode"})
                audio = speak_wav(text)
                if audio is None:
                    return self._send(503, {"error": state["assistant_error"] or "voice not loaded"})
                return self._send(200, {"audio": audio})
            if self.path.startswith("/assistant/ask"):
                question = (body.get("question") or "").strip()
                if MOCK:
                    return self._send(200, mock_ask(question, image, False))
                if state["assistant"] is None:
                    return self._send(503, {"error": state["assistant_error"] or "assistant still loading"})
                if not question and body.get("audio"):
                    question = transcribe(base64.b64decode(body["audio"]))
                if not question:
                    return self._send(200, {"question": "", "answer": "I didn't catch that. Could you say it again?", "usedCamera": False, "audio": None})
                return self._send(200, ask(question, image, bool(body.get("speak"))))
            self._send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *args):
        pass  # quiet; errors print above


if __name__ == "__main__":
    threading.Thread(target=load_everything, daemon=True).start()
    print(f"Camera + voice service on http://127.0.0.1:{PORT}  (mock={MOCK})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
