"""
Offline voice assistant for blind and low-vision users.

Hands-free conversation: it greets you, listens, answers questions about your
surroundings using the webcam, and also answers general questions without the camera.
It starts speaking as soon as the first sentence is ready, and you can interrupt it
while it is speaking ("stop, describe the left side instead").

Speech to text: faster-whisper    Model: Ollama (gemma3:4b)    Voice: Piper
Run it from the folder that contains your Piper voice files (Mac).
Headphones are strongly recommended, otherwise it can hear its own voice.
"""

import hashlib
import os
import queue
import re
import subprocess
import sys
import threading
import time
import wave
from collections import deque
from itertools import count

import cv2
import numpy as np
import ollama
import sounddevice as sd
from faster_whisper import WhisperModel

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "voice_cache")    # saved audio for fixed phrases like the greeting
TMP_DIR = os.path.join(HERE, "tmp_audio")        # short-lived audio for each spoken sentence
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(TMP_DIR, exist_ok=True)

# ---- Settings you can change -------------------------------------------
VISION_MODEL = "gemma3:4b"    # for better descriptions try "gemma3:12b" or "qwen2.5vl:7b" if you have the memory
VOICE = "en_GB-southern_english_female-low"   # your downloaded Piper voice

# Speech recognition. Bigger = more accurate but slower. Options: "base.en", "small.en",
# "distil-medium.en" (noticeably more accurate, still quick), "large-v3-turbo" (best, slower on CPU)
WHISPER_SIZE = "small.en"
WHISPER_BEAM = 5          # how many guesses it compares. 5 is more accurate than 3 for little extra time
# A short hint that helps it recognise the words you are likely to say. Set to None to switch off
# (do that if it ever "hears" these words when you say nothing).
WHISPER_HINT = "A person asking a voice assistant about their surroundings, like doors, signs, stairs, left and right."
# The recorder already cuts out silence, so Whisper's own speech filter is off by default:
# it tends to chop off soft first words and very short replies like "no" or "help".
# Turn it on if it starts inventing words from background noise.
USE_VAD = False
SAVE_DEBUG_AUDIO = True   # saves your last question as last_question.wav so you can hear what it heard

SAMPLE_RATE = 16000
SILENCE_SECONDS = 1.4     # a pause this long means "I've finished speaking" (1.0 cut people off mid-question)
MAX_LISTEN_SECONDS = 15
WAIT_FOR_SPEECH_SECONDS = 8
PREROLL_BLOCKS = 5        # keeps the 0.5 seconds before you spoke, so the first word isn't cut off
CAMERA_INDEX = 0
DARK_FRAME_LEVEL = 25     # average brightness (0-255) below which the picture counts as too dark

# Interrupting (barge-in)
BARGE_IN = True           # set to False to stop it listening while it talks
BARGE_IN_LEVEL = 0.05     # how loud you must be to interrupt. Must be ABOVE the level of its own voice
BARGE_IN_BLOCKS = 3       # loud for this many 0.1 second blocks = a real interruption
DEBUG_LEVELS = True       # prints sound levels while it talks, to help you tune BARGE_IN_LEVEL
# -------------------------------------------------------------------------

# Set automatically at start-up by measuring the noise in your room
SILENCE_LEVEL = 0.01
END_FACTOR = 0.7          # speech counts as finished when it drops below this share of SILENCE_LEVEL

GREETING = (
    "Hi, I'm your camera guide. I can describe what is around you, read signs and labels, "
    "or answer general questions. Do you need help with anything? "
    "You can interrupt me at any time, and say help to hear what I can do."
)

HELP_TEXT = (
    "Here is what I can do. Ask me what is in front of you, whether a door is open, "
    "what a sign says, or where something is. You can also ask me general questions. "
    "You can interrupt me while I am talking. Say repeat to hear my last answer again. "
    "Say goodbye when you are finished. Point the camera where you want me to look."
)

CAMERA_PROMPT = (
    "You are a calm, friendly guide for a blind or low-vision person. The image is what "
    "their camera sees right now. Answer their question about the surroundings in one or "
    "two short spoken sentences, in plain words with no lists, no asterisks and no "
    "formatting. Mention hazards first if there are any. Use clear directions such as left, "
    "right and ahead, with approximate distances. Do not repeat what you have already told "
    "them unless asked. If their question is not about the picture, just answer it normally. "
    "If the picture is blurry, too dark, or does not show what they asked about, say so and "
    "suggest how to move the camera, for example tilt it down or step back. "
    "If you cannot tell from the image, say so honestly instead of guessing. If they ask "
    "whether it is safe to do something, such as crossing a road, explain that you cannot be "
    "relied on for safety and that they should use their cane, guide dog or ask someone nearby. "
    "When it would genuinely help, end with one short natural follow-up question. "
    "Never ask more than one question, and skip the follow-up if it would not add anything."
)

TEXT_PROMPT = (
    "You are a calm, friendly voice assistant for a blind or low-vision person. Answer any "
    "question helpfully in one or two short spoken sentences, in plain words with no lists, "
    "no asterisks and no formatting. If you are not sure of a fact, say so honestly. "
    "If answering properly would require seeing the person's surroundings, for example they "
    "ask about something in front of them or point at something, reply with exactly the single "
    "word NEED_CAMERA and nothing else. Never pretend to see anything. "
    "When it would genuinely help, end with one short natural follow-up question."
)

# Words that clearly mean "look through the camera". Anything else goes to the text path first,
# and the model replies NEED_CAMERA if it decides it has to look.
CAMERA_WORDS = {
    "see", "look", "looking", "front", "around", "surroundings", "ahead", "behind", "nearby",
    "read", "sign", "signs", "door", "doors", "stairs", "steps", "wearing", "holding",
    "describe", "camera", "picture", "colour", "color", "table", "room", "label", "menu", "screen",
}
CAMERA_PHRASES = ("what is this", "what's this", "what is that", "what's that", "how far",
                  "is there a", "are there any", "in front of me")

EXIT_WORDS = {"goodbye", "good bye", "bye", "bye bye", "quit", "exit", "i'm done", "im done",
              "stop the app", "close the app", "that's all for now", "thats all for now"}
HELP_WORDS = {"help", "help me", "what can you do", "what can you help with", "options"}
REPEAT_WORDS = {"repeat", "repeat that", "say that again", "can you repeat that",
                "what did you say", "again", "say again"}
NO_WORDS = {"no", "nope", "no thanks", "no thank you", "nothing", "that's all", "thats all",
            "not right now", "i'm fine", "im fine"}
THANKS_WORDS = {"thanks", "thank you", "thank you very much", "thank you so much", "cheers"}

# Words people say when they interrupt, removed from the start of the new request
FILLER_STARTS = ["hold on", "hang on", "never mind", "nevermind", "excuse me", "no wait",
                 "stop", "wait", "actually", "sorry", "okay", "ok", "hey", "no", "um", "uh"]

history = []            # text-only memory of the last few turns, so follow-up questions work
pending_audio = None    # what the user said while interrupting, waiting to be handled
piper_voice = None      # the voice, loaded once so it doesn't reload for every sentence
synth_lock = threading.Lock()
file_counter = count()
camera = None


# =========================== Camera (kept open for speed) ===========================

def sharpness(frame):
    """Higher = sharper. Used to skip blurry frames caused by hand movement."""
    small = cv2.resize(frame, (320, 240))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


class Camera:
    """Keeps the webcam open in the background so a picture is available instantly."""

    def __init__(self, index):
        self.cap = cv2.VideoCapture(index)
        self.frames = deque(maxlen=6)     # the last few frames, so we can pick the sharpest
        self.lock = threading.Lock()
        self.running = self.cap.isOpened()
        if self.running:
            threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.running:
            ok, frame = self.cap.read()
            if ok:
                with self.lock:
                    self.frames.append(frame)
            else:
                time.sleep(0.05)

    def latest(self):
        """Returns the sharpest of the most recent frames (roughly the last fifth of a second)."""
        with self.lock:
            frames = list(self.frames)
        if not frames:
            return None
        return max(frames, key=sharpness).copy()

    def close(self):
        self.running = False
        time.sleep(0.1)
        self.cap.release()


def grab_frame():
    """Returns (jpeg_bytes, average_brightness) from the most recent camera picture."""
    frame = camera.latest() if camera else None
    if frame is None:
        return None, 0

    brightness = float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean())
    h, w = frame.shape[:2]
    scale = min(1.0, 896 / max(h, w))    # gemma3 looks at images at 896 pixels
    if scale < 1.0:
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return (buffer.tobytes() if ok else None), brightness


# =========================== Voice output (Piper) ===========================

def load_voice():
    """Loads Piper once. If this fails, the slower command-line Piper is used instead."""
    global piper_voice
    try:
        from piper import PiperVoice
        model_path = os.path.join(HERE, VOICE + ".onnx")
        piper_voice = PiperVoice.load(model_path)
        print("(Piper voice loaded)")
    except Exception as e:
        piper_voice = None
        print("(Could not load Piper in memory, using the slower method:", e, ")")


def synth_to_file(text, path):
    """Turns text into a wav file. Returns True on success."""
    with synth_lock:
        if piper_voice is not None:
            try:
                with wave.open(path, "wb") as wf:
                    if hasattr(piper_voice, "synthesize_wav"):
                        piper_voice.synthesize_wav(text, wf)
                    else:
                        piper_voice.synthesize(text, wf)
                return True
            except Exception as e:
                print("(Piper in-memory failed:", e, ")")
        try:
            subprocess.run(
                [sys.executable, "-m", "piper", "-m", VOICE, "-f", path, "--", text],
                cwd=HERE,
                check=True,
            )
            return True
        except Exception as e:
            print("(Piper command failed, using the Mac voice instead:", e, ")")
            return False


def synth_temp(text):
    path = os.path.join(TMP_DIR, f"s_{next(file_counter)}.wav")
    return path if synth_to_file(text, path) else None


def synth_cached(text):
    """Like synth_temp, but remembers the audio so repeated phrases are instant."""
    name = hashlib.md5((VOICE + text).encode()).hexdigest() + ".wav"
    path = os.path.join(CACHE_DIR, name)
    if os.path.exists(path):
        return path
    return path if synth_to_file(text, path) else None


def clean_for_speech(text):
    for ch in "*#_`":
        text = text.replace(ch, "")
    return " ".join(text.split())


def rms(block):
    return float(np.sqrt(np.mean(block ** 2)))


def keep_recording(stream, chunks):
    """Keeps recording from an open stream until the user stops talking."""
    block_seconds = 0.1
    blocksize = int(SAMPLE_RATE * block_seconds)
    silent_for = 0.0
    begin = time.time()
    while time.time() - begin < MAX_LISTEN_SECONDS:
        data, _ = stream.read(blocksize)
        chunks.append(data.copy())
        if rms(data) > SILENCE_LEVEL * END_FACTOR:
            silent_for = 0.0
        else:
            silent_for += block_seconds
        if silent_for >= SILENCE_SECONDS:
            break
    return np.concatenate(chunks).flatten()


def listen_while_playing(player):
    """
    Listens to the microphone while audio is playing. If the user starts talking,
    stops the audio and returns what they said. Returns None if it played to the end.
    """
    block_seconds = 0.1
    blocksize = int(SAMPLE_RATE * block_seconds)
    # Everything from the last moment or so, so the start of the interruption isn't lost
    recent = deque(maxlen=PREROLL_BLOCKS + BARGE_IN_BLOCKS)
    loud_blocks = 0
    peak = 0.0

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=blocksize) as stream:
        while player.poll() is None:
            data, _ = stream.read(blocksize)
            recent.append(data.copy())
            level = rms(data)
            peak = max(peak, level)

            loud_blocks = loud_blocks + 1 if level > BARGE_IN_LEVEL else 0

            if loud_blocks >= BARGE_IN_BLOCKS:
                player.terminate()
                try:
                    player.wait(timeout=1)
                except Exception:
                    pass
                print(f"(interrupted at sound level {level:.3f})")
                return keep_recording(stream, list(recent))

    if DEBUG_LEVELS:
        print(f"(loudest sound while I spoke: {peak:.3f}; interrupt level is {BARGE_IN_LEVEL})")
    return None


def play(text, wav):
    """
    Plays one piece of speech. Returns True if it finished, or False if the user
    interrupted (what they said is saved in pending_audio).
    """
    global pending_audio
    command = ["afplay", wav] if wav else ["say", text]     # afplay is the Mac audio player
    player = subprocess.Popen(command)
    if BARGE_IN:
        captured = listen_while_playing(player)
        if captured is not None:
            pending_audio = captured
            return False
    else:
        player.wait()
    return True


def speak(text):
    """Speaks a fixed phrase (greeting, help, short replies)."""
    text = clean_for_speech(text)
    print("Assistant:", text)
    play(text, synth_cached(text))
    time.sleep(0.2)   # let the room go quiet so we don't hear ourselves


def cue(name):
    """Plays a short built-in Mac sound so the user knows what is happening."""
    path = f"/System/Library/Sounds/{name}.aiff"
    if os.path.exists(path):
        subprocess.run(["afplay", path])


# =========================== Voice input (microphone + Whisper) ===========================

def calibrate_noise():
    """Measures the background noise so the 'are you speaking?' level suits your room."""
    global SILENCE_LEVEL
    print("Measuring room noise for a moment, please stay quiet...")
    blocksize = int(SAMPLE_RATE * 0.1)
    levels = []
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=blocksize) as stream:
        for _ in range(15):
            data, _ = stream.read(blocksize)
            levels.append(rms(data))
    noise = float(np.median(levels))
    SILENCE_LEVEL = min(max(noise * 3, 0.006), 0.05)
    print(f"(room noise {noise:.4f}, speech level set to {SILENCE_LEVEL:.4f})")


def record_question():
    """Records from the microphone until you stop talking. Returns audio or None."""
    block_seconds = 0.1
    blocksize = int(SAMPLE_RATE * block_seconds)
    chunks = []
    preroll = deque(maxlen=PREROLL_BLOCKS)
    started = False
    silent_for = 0.0
    begin = time.time()

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=blocksize) as stream:
        while True:
            elapsed = time.time() - begin
            if not started and elapsed > WAIT_FOR_SPEECH_SECONDS:
                return None
            if started and elapsed > MAX_LISTEN_SECONDS + WAIT_FOR_SPEECH_SECONDS:
                break

            data, _ = stream.read(blocksize)
            level = rms(data)

            if not started:
                if level > SILENCE_LEVEL:
                    started = True
                    chunks.extend(preroll)
                    silent_for = 0.0
            else:
                if level > SILENCE_LEVEL * END_FACTOR:
                    silent_for = 0.0
                else:
                    silent_for += block_seconds

            if started:
                chunks.append(data.copy())
                if silent_for >= SILENCE_SECONDS:
                    break
            else:
                preroll.append(data.copy())

    return np.concatenate(chunks).flatten()


def save_debug_wav(audio):
    try:
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
        with wave.open(os.path.join(HERE, "last_question.wav"), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm.tobytes())
    except Exception:
        pass


def transcribe(whisper, audio):
    """Turns recorded audio into text. Returns an empty string if it isn't confident."""
    if audio is None or audio.size == 0:
        return ""
    audio = audio.astype(np.float32)
    audio = audio - float(np.mean(audio))          # remove any DC offset from the mic
    if SAVE_DEBUG_AUDIO:
        save_debug_wav(audio)
    peak = float(np.max(np.abs(audio)))
    if peak < 1e-4:
        return ""
    audio = audio / peak * 0.9           # make quiet speech louder before transcribing

    options = dict(
        language="en",
        beam_size=WHISPER_BEAM,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        initial_prompt=WHISPER_HINT,
    )
    segments = None
    if USE_VAD:
        try:
            segments, _ = whisper.transcribe(
                audio,
                vad_filter=True,
                vad_parameters=dict(threshold=0.3, min_silence_duration_ms=700, speech_pad_ms=400),
                **options,
            )
            segments = list(segments)
        except Exception as e:
            print("(voice activity filter failed, trying without it:", e, ")")
            segments = None
    if segments is None:
        segments, _ = whisper.transcribe(audio, **options)
        segments = list(segments)

    parts = []
    for s in segments:
        if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
            continue                      # probably just noise
        parts.append(s.text.strip())
    text = " ".join(parts).strip()

    # Whisper sometimes echoes the hint back when it hears almost nothing
    if WHISPER_HINT and text:
        t = normalise(text)
        if len(t.split()) >= 5 and t in normalise(WHISPER_HINT):
            return ""
    return text


def load_whisper():
    print(f"Loading speech recognition '{WHISPER_SIZE}' (the first run downloads it, so use wifi)...")
    try:
        return WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8")
    except Exception as e:
        print(f"(Could not load '{WHISPER_SIZE}': {e}. Falling back to small.en)")
        return WhisperModel("small.en", device="cpu", compute_type="int8")


# =========================== The model (answers arrive sentence by sentence) ===========================

def build_messages(system_prompt, question, jpeg=None):
    user_message = {"role": "user", "content": question}
    if jpeg is not None:
        user_message["images"] = [jpeg]
    return [{"role": "system", "content": system_prompt}] + history[-6:] + [user_message]


def stream_sentences(messages, stop):
    """Asks the model and yields its answer one sentence at a time as it is written."""
    buf = ""
    stream = ollama.chat(
        model=VISION_MODEL,
        messages=messages,
        stream=True,
        keep_alive="30m",                        # keeps the model loaded so it answers faster
        options={"num_predict": 120, "temperature": 0.3},
    )
    for chunk in stream:
        if stop.is_set():
            return
        buf += chunk["message"]["content"]
        while True:
            m = re.search(r"[.!?]\s", buf)
            if not m:
                break
            sentence, buf = buf[:m.end()].strip(), buf[m.end():]
            if sentence:
                yield sentence
    if not stop.is_set() and buf.strip():
        yield buf.strip()


def remember(question, answer):
    history.append({"role": "user", "content": question})
    history.append({"role": "assistant", "content": answer})


def needs_camera(question):
    n = normalise(question)
    if any(phrase in n for phrase in CAMERA_PHRASES):
        return True
    words = set(re.findall(r"[a-z']+", n))
    return bool(words & CAMERA_WORDS)


def produce(question, out_q, stop, info):
    """
    Runs in a background thread. Works out the answer sentence by sentence, turns each
    sentence into audio, and puts (text, wav) on the queue so speaking can start straight away.
    """
    spoken = []
    ok = True

    def emit(sentence):
        sentence = clean_for_speech(sentence)
        if not sentence or stop.is_set():
            return
        print("Assistant:", sentence)
        wav = synth_temp(sentence)
        if stop.is_set():
            return
        out_q.put((sentence, wav))
        spoken.append(sentence)

    try:
        use_camera = needs_camera(question)

        if not use_camera:
            sentences = stream_sentences(build_messages(TEXT_PROMPT, question), stop)
            first = next(sentences, None)
            if first is not None and "NEED_CAMERA" in first.upper():
                use_camera = True
                sentences.close()
            else:
                if first is not None:
                    emit(first)
                for s in sentences:
                    emit(s)

        if use_camera:
            info["camera"] = True
            jpeg, brightness = grab_frame()
            if jpeg is None:
                ok = False
                emit("I can't reach the camera. Please check that camera permission is switched on.")
            elif brightness < DARK_FRAME_LEVEL:
                ok = False
                emit("It's very dark, or the camera might be covered. Could you turn on a light or point the camera somewhere else?")
            else:
                for s in stream_sentences(build_messages(CAMERA_PROMPT, question, jpeg), stop):
                    emit(s)

        if ok and spoken and not stop.is_set():
            remember(question, " ".join(spoken))
    except Exception as e:
        print("Model error:", e)
        emit("Sorry, I had a problem working that out. Could you try again?")
    finally:
        out_q.put(None)


def warm_up_model():
    """Loads the model into memory in the background so the first question isn't slow."""
    try:
        ollama.chat(
            model=VISION_MODEL,
            messages=[{"role": "user", "content": "Say hi."}],
            keep_alive="30m",
            options={"num_predict": 1},
        )
    except Exception as e:
        print("(Could not warm up the model:", e, ")")


# =========================== Helpers and main loop ===========================

def normalise(text):
    """Lower-case, no punctuation, single spaces. 'Bye-bye!' -> 'bye bye', 'Help, please.' -> 'help'."""
    t = text.lower().replace("-", " ").replace("\u2019", "'")
    t = re.sub(r"[^a-z0-9' ]+", " ", t)
    t = " ".join(t.split())
    for tail in (" please", " now"):
        if t.endswith(tail) and len(t) > len(tail):
            t = t[: -len(tail)]
    if t.startswith("please "):
        t = t[len("please "):]
    return t


def strip_interruption(text):
    """Removes interrupting words like 'stop' or 'wait' from the start of the request."""
    t = text.strip()
    changed = True
    while changed and t:
        changed = False
        low = t.lower()
        for p in FILLER_STARTS:
            if low.startswith(p) and (len(low) == len(p) or not low[len(p)].isalnum()):
                t = t[len(p):].lstrip(" ,.!?-;:")
                changed = True
                break
    return t


def clear_temp_audio():
    for f in os.listdir(TMP_DIR):
        try:
            os.remove(os.path.join(TMP_DIR, f))
        except OSError:
            pass


def main():
    global pending_audio, camera

    clear_temp_audio()
    calibrate_noise()

    camera = Camera(CAMERA_INDEX)
    if not camera.running:
        print("(Could not open the camera. Check camera permission for this app.)")

    whisper = load_whisper()
    load_voice()
    threading.Thread(target=warm_up_model, daemon=True).start()

    speak(GREETING)

    silent_rounds = 0
    last_answer = ""

    while True:
        interrupted = False
        if pending_audio is not None:
            audio = pending_audio          # the user interrupted, so use what they said
            pending_audio = None
            interrupted = True
        else:
            cue("Pop")                     # a short sound means "I'm listening now"
            audio = record_question()

        # ---- Nothing heard: gently check in, then pause ----
        if audio is None:
            silent_rounds += 1
            if silent_rounds == 1:
                speak("I'm still here. Do you need help with anything? Say help to hear what I can do.")
            elif silent_rounds == 2:
                speak("Just ask whenever you're ready, for example: what is in front of me?")
            else:
                speak("I'll pause now. Press enter when you need me.")
                try:
                    input("\nPress Enter to wake me up (Ctrl+C to quit)... ")
                except (EOFError, KeyboardInterrupt):
                    break
                silent_rounds = 0
                speak("I'm listening. What would you like to know?")
            continue

        silent_rounds = 0
        t_heard = time.time()
        question = transcribe(whisper, audio)
        print(f"You said: {question}   (transcribed in {time.time() - t_heard:.1f}s)")
        n = normalise(question)

        if not n:
            speak("Sorry, I didn't catch that. Could you say it again?")
            continue

        # ---- Spoken commands ----
        if n in EXIT_WORDS:
            speak("Goodbye. Take care.")
            break

        if interrupted:
            stripped = strip_interruption(question)
            if not normalise(stripped):
                speak("Okay, I've stopped. What would you like me to do instead?")
                continue
            question = stripped
            n = normalise(question)
            print("Understood as:", question)

        if n in EXIT_WORDS:
            speak("Goodbye. Take care.")
            break
        if n in HELP_WORDS:
            speak(HELP_TEXT)
            continue
        if n in REPEAT_WORDS:
            speak(last_answer if last_answer else "I haven't said anything yet. Ask me something first.")
            continue
        if n in NO_WORDS:
            speak("Okay. I'm here whenever you need me. Just ask.")
            continue
        if n in THANKS_WORDS:
            speak("You're welcome. Let me know if you need anything else.")
            continue

        # ---- Work out the answer, speaking each sentence as soon as it is ready ----
        cue("Tink")                        # a short sound means "I heard you, thinking"
        print("Thinking...")
        t0 = time.time()
        out_q = queue.Queue()
        stop = threading.Event()
        info = {}
        threading.Thread(target=produce, args=(question, out_q, stop, info), daemon=True).start()

        spoken = []
        reported = False
        while True:
            try:
                item = out_q.get(timeout=90)
            except queue.Empty:
                print("(no answer in time)")
                stop.set()
                break
            if item is None:
                break
            text, wav = item
            if not reported:
                reported = True
                route = "camera" if info.get("camera") else "no camera"
                print(f"(first words after {time.time() - t0:.1f}s, {route})")
            spoken.append(text)
            finished = play(text, wav)
            if wav:
                try:
                    os.remove(wav)
                except OSError:
                    pass
            if not finished:
                stop.set()                 # the user interrupted, so stop working on this answer
                break

        if spoken:
            last_answer = " ".join(spoken)
        print(f"(answer finished after {time.time() - t0:.1f}s)")
        time.sleep(0.2)

    if camera:
        camera.close()
    print("Bye.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nBye.")