"""
Offline voice assistant for blind and low-vision users.

Hands-free conversation: it greets you, listens, answers questions about your
surroundings using the webcam, and also answers general questions without the camera.
It starts speaking as soon as the first sentence is ready, and you can interrupt it
while it is speaking ("stop, describe the left side instead").

Focusing on your voice:
  - It keeps learning what the room sounds like when nobody is talking (fans, traffic, hum).
  - It only starts listening when it hears something that sounds like a voice, clearly
    louder than that background.
  - Once you start talking it remembers how loud YOU are, so quieter voices further away
    (a TV, people chatting across the room) do not keep it listening.
  - Before transcribing, it removes the background noise and drops any stretches of speech
    that are much quieter than you, so only the person asking is sent to Whisper.

Speech to text: faster-whisper    Model: Ollama (gemma3:4b)    Voice: Piper
Run it from the folder that contains your Piper voice files (Mac).
Headphones are strongly recommended, otherwise it can hear its own voice.
"""

import hashlib
import io
import json
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
# "auto" picks the most accurate vision model you have installed that your Mac has the memory
# for, from the list below (best first). Or put one model name here to always use it.
VISION_MODEL = "auto"
VISION_MODEL_CHOICES = [
    ("qwen2.5vl:7b", 16),     # (model, GB of memory needed). Best at reading text and positions, quick
    ("gemma3:12b", 16),       # very good descriptions, a bit slower
    ("gemma3:4b", 0),         # the smallest and fastest, least accurate
]
SPECULATIVE_ANSWERS = True   # starts working out the answer during the pause at the end of your
                             # question, so it is often ready the moment you finish
# The same settings must be used for every request, otherwise Ollama reloads the model (slow)
MODEL_OPTIONS = {"num_ctx": 4096, "num_predict": 200, "temperature": 0.1, "top_p": 0.9}
VOICE = "en_GB-southern_english_female-low"   # your downloaded Piper voice
SENTENCE_GAP = 0.1        # pause between sentences, in seconds (Piper's own long silences are trimmed)

# Which microphone to use. None = the Mac's default. A headset or AirPods mic close to your
# mouth is the single best way to ignore other people. To see the list, run:
#     python3 -m sounddevice
# and put the number (or part of the name, like "AirPods") here.
INPUT_DEVICE = None

# Speech recognition. Bigger = more accurate but slower. Options: "base.en", "small.en",
# "distil-medium.en" (noticeably more accurate, still quick), "large-v3-turbo" (best, slower on CPU)
WHISPER_SIZE = "small.en"
WHISPER_BEAM = 5
# A short hint that helps it recognise the words you are likely to say. Set to None to switch off.
WHISPER_HINT = "A person asking a voice assistant about their surroundings, like doors, signs, stairs, left and right."
SAVE_DEBUG_AUDIO = True   # saves last_question.wav (raw) and last_question_clean.wav (what Whisper heard)
SAVE_DEBUG_IMAGE = True   # saves last_view.jpg: exactly what the guide looked at. Open it if an
                          # answer seems wrong, to check the camera is pointing where you think

# ---- Focusing on the person asking ----
NOISE_REDUCTION = 0.75    # how strongly to remove background noise. 0 = off, 1 = strongest.
                          # Too high can make your voice sound watery, which hurts accuracy.
SPEECH_SNR_DB = 8         # how much louder than the background a sound must be to count as a voice
SPEAKER_DROP_DB = 10      # while you talk, voices this much quieter than you are ignored as background.
                          # Raise it if it stops listening while you're still talking quietly.
FOCUS_ON_MAIN_SPEAKER = True
MAIN_SPEAKER_DB = 10      # stretches of speech this much quieter than the loudest one are cut out
START_BLOCKS = 2          # voice for this many 0.1 second blocks in a row = you have started talking
HIGHPASS_HZ = 90          # removes rumble below this (traffic, air conditioning, desk bumps)
SPEECH_BAND = (250, 3800) # the range of pitches where voices carry most of their information

SAMPLE_RATE = 16000
BLOCK_SECONDS = 0.1
BLOCK = int(SAMPLE_RATE * BLOCK_SECONDS)
SILENCE_SECONDS = 1.2     # a pause this long means "I've finished speaking". Raise to 1.4 if it
                          # cuts you off; lower for faster replies
EARLY_TRANSCRIBE_SECONDS = 0.3   # starts working out your words (and the answer) during that pause
MAX_LISTEN_SECONDS = 15
WAIT_FOR_SPEECH_SECONDS = 8
PREROLL_BLOCKS = 5        # keeps the 0.5 seconds before you spoke, so the first word isn't cut off
CAMERA_INDEX = 0
CAMERA_WIDTH = 1920       # asks the camera for full HD, so signs and small text are readable
CAMERA_HEIGHT = 1080
MIRROR_CAMERA = False     # set to True if left and right come out the wrong way round
DARK_FRAME_LEVEL = 25     # average brightness (0-255) below which the picture counts as too dark
BLUR_RATIO = 0.4          # a frame less than this share as sharp as the camera has recently been
                          # counts as blurry (a moving hand), so it waits a moment for a steadier one
PEOPLE_DETECTOR = True    # uses OpenCV's built-in face and person detectors so people are never missed
ZOOM_FOR_READING = True   # when you ask it to read something, also sends a zoomed-in view of the centre
DETAIL_FOR_FINDING = True # when you ask where something is, also sends the left and right halves in
                          # more detail. More accurate positions, but adds a little thinking time

# Interrupting (barge-in)
# While it talks, it keeps talking through background noise and other people, and only stops
# when you say its name or one of the stop words below. Anything else you say is ignored.
BARGE_IN = True           # set to False to stop it listening while it talks
BARGE_IN_LEVEL = 0.05     # how loud you must be for it to check what you said. Must be ABOVE the
                          # level of its own voice (DEBUG_LEVELS prints both to help you set it)
BARGE_IN_BLOCKS = 2       # voice in this many of the last 3 blocks = start checking what you said
# Its name. Works anywhere in what you say ("hey Acuity", "Acuity, what's that?").
# The extra spellings are how speech recognition sometimes mishears the name.
WAKE_NAMES = ["acuity", "a cuity", "accuity", "acuty", "aquity", "equity"]
# Stop words. These only count at the START of what you say, so "where's the bus stop"
# said to someone else won't stop it, but "stop, describe the left side" will.
STOP_WORDS = ["stop", "wait", "hold on", "hang on", "pause", "cancel", "excuse me",
              "be quiet", "quiet", "shush", "enough", "never mind", "nevermind"]
KEYWORD_LISTEN_SECONDS = 4   # how long into what you say it keeps checking for those words
DEBUG_LEVELS = True       # prints sound levels to help you tune the settings above

# Sounds that tell you whose turn it is (made by the program, nothing to download)
#   your turn  : two notes going UP   - I'm listening, you can talk now
#   heard you  : one soft low tick    - I can hear you talking
#   got it     : one short high note  - you've finished, I'm thinking
#   my turn    : two notes going DOWN - I'm about to speak
SOUND_CUES = True
CUE_VOLUME = 0.35         # 0 to 1
CUE_WHEN_HEARD = True     # plays the soft tick while you talk. Best with headphones,
                          # otherwise the microphone picks it up (it's short, so usually fine)
# -------------------------------------------------------------------------

GREETING = (
    "Hello, I'm Acuity, your navigation guide. I can describe what is around you, read signs, "
    "and help you find your way. How can I help? "
    "To interrupt me, say hey Acuity or stop. Say help to hear what I can do."
)

HELP_TEXT = (
    "Here is what I can do. Ask me what is in front of you, whether a path or door is clear, "
    "what a sign or bus number says, or where something is. You can also ask about routes and transport. "
    "To interrupt me while I am talking, say hey Acuity or stop. Say repeat to hear my last answer again. "
    "Say goodbye when you are finished. Point the camera where you want me to look."
)

# ---- How the guide behaves ----
GUIDE_ROLE = (
    "You are a professional guide for a blind or low-vision person, who may be indoors or "
    "outside. Speak like a calm, experienced guide: clear, concise, respectful and to the point, "
    "with no jokes, no filler and no exclamation marks. Answer in one or two short spoken "
    "sentences. When there is a camera picture, use up to three sentences, or up to five when "
    "describing their surroundings, in plain words, with no lists, no asterisks and no formatting. "
)

HONESTY_RULES = (
    "Their safety depends on what you tell them, so being right matters more than saying a lot. "
    "Only mention something if you can clearly see it in the latest picture. Do not mention "
    "anything you are not sure is there, and never add things that are usually found in places "
    "like this but are not visible. If you can see something but are not sure what it is, do not "
    "guess its name: describe it by its shape, size, colour and position instead, for example a "
    "tall dark object about two metres to your left. Never guess what kind of place they are in; "
    "only name a place if a sign or something unmistakable in the picture shows it. Never guess "
    "distances, numbers or words you cannot read clearly; say you are not sure instead. "
    "People are an exception: if you can see a person, or part of one such as a face, head, arm "
    "or body, always mention them, even if they are close to the camera or partly hidden. That is "
    "not guessing. "
    "Never tell them something is safe. If they ask whether it is safe to cross or step forward, "
    "say you cannot confirm that and that they should rely on their cane, guide dog, a signal, or "
    "a person nearby. "
    "Always mention anything you can see in or near their way, even if you cannot tell what it "
    "is. A missed obstacle is much worse than an extra mention. Put anything in their way first. "
    "Never say the way is clear or that nothing is there unless you can see the ground ahead and "
    "have checked it. Do not add general warnings with no specific reason, such as be careful, "
    "stay alert or stay safe. "
)

FOLLOW_UP_RULE = (
    "Only end with a short follow-up question when it genuinely helps them get where they are "
    "going, and never ask more than one."
)

# One set of instructions for every request. Because it never changes, Ollama can reuse the
# work it did on it last time, which makes every answer start faster.
SYSTEM_PROMPT = (
    GUIDE_ROLE
    + "Your main job is helping them get around safely and understand what is around them. If "
    "they ask about something else, answer it briefly and politely. "
    "When their message has a camera picture attached, it shows what is in front of them right "
    "now, taken from where they are standing and facing. The left of the picture is their left and "
    "the right of the picture is their right. Answer only about what the picture actually shows. "
    "Use clear directions such as left, right and straight ahead, with approximate "
    "distances in steps or metres, and say when a distance is only an estimate. When reading "
    "text, read the words exactly as written, and if only part is readable, say which part you "
    "could not read. Do not repeat what you have already told them unless asked. If the picture is "
    "blurry, too dark, or does not show what they asked about, say so and tell them how to move the "
    "camera, for example tilt it down or turn slightly left. "
    "Earlier answers in this conversation were about earlier pictures and the scene may have "
    "changed, so describe only what is in the picture attached to the latest message. "
    "Whenever there is a picture, refer to the important things you can clearly see in it: "
    "anything in their way, every person you can see, vehicles, and landmarks such as doors or "
    "stairs. Name each one with where it is and roughly how far away. Answer their question "
    "first, then briefly add any important thing they did not ask about. Only mention things that "
    "matter for getting around or that they asked about. Leave out background things such as "
    "pipes, vents, wires on walls or ceilings, lights, shelves, posters, plants, decorations and "
    "wall colours, unless they are in their way or they ask. "
    "When there is no picture attached and answering properly would require seeing their "
    "surroundings, reply with exactly the single word NEED_CAMERA and nothing else. Never pretend "
    "to see anything. "
    + HONESTY_RULES
    + FOLLOW_UP_RULE
)

# Words that show a question is about getting around. A question without any of these is
# treated as off-topic, and the guide makes sure a safety reminder is spoken after the answer.
TRAVEL_WORDS = {
    "bus", "buses", "train", "trains", "tube", "underground", "metro", "tram", "taxi", "uber",
    "station", "platform", "stop", "route", "directions", "direction", "way", "map", "journey",
    "travel", "walk", "walking", "cross", "crossing", "road", "street", "pavement", "path", "kerb",
    "curb", "left", "right", "straight", "turn", "north", "south", "east", "west", "near",
    "nearest", "far", "where", "exit", "entrance", "ticket", "timetable", "arrive", "leave",
    "get", "go", "going", "lift", "elevator", "escalator", "stairs", "steps", "door", "traffic",
    "lights", "signal", "car", "cars", "bike", "cycle", "airport", "flight", "ferry", "location",
}
# Off by default: you asked for warnings only when there is an actual hazard. Set to True to
# bring back a short "stay alert" reminder after answers to questions unrelated to getting around.
OFF_TOPIC_REMINDER = False
SAFETY_REMINDERS = [
    "Please stay alert to your surroundings while you're out.",
    "Remember to keep paying attention to where you're going.",
    "Please stay aware of what's around you as you move.",
]
REMINDER_HINTS = ("alert", "careful", "caution", "aware", "attention", "surroundings", "safe")

# Words that clearly mean "look through the camera". Anything else goes to the text path first,
# and the model replies NEED_CAMERA if it decides it has to look.
CAMERA_WORDS = {
    "see", "look", "looking", "front", "around", "surroundings", "ahead", "behind", "nearby",
    "read", "sign", "signs", "door", "doors", "stairs", "steps", "wearing", "holding",
    "describe", "camera", "picture", "colour", "color", "table", "room", "label", "menu", "screen",
    "clear", "path", "obstacle", "obstacles", "kerb", "curb", "crossing", "traffic", "lights",
    "car", "cars", "person", "people", "anyone", "someone", "here", "this", "that", "these",
    "open", "closed", "empty", "seat", "queue", "exit", "entrance", "floor", "ground", "wall",
    "board", "written", "says", "number", "platform", "left", "right",
}
# Words that mean "read something". These also get a zoomed-in view for small text.
READ_WORDS = {"read", "sign", "signs", "say", "says", "written", "label", "menu", "text", "number",
              "numbers", "price", "screen", "board", "departure", "departures", "timetable", "name"}
# Words that mean "where is something". These also get a more detailed left and right view.
FIND_WORDS = {"where", "where's", "find", "which", "locate", "left", "right", "side", "position"}
# Words that mean "what's in my way". These get a close-up of the ground and a careful check.
PATH_WORDS = {"path", "clear", "way", "walk", "walking", "obstacle", "obstacles",
              "blocking", "blocked", "forward", "straight", "safe", "trip", "floor", "ground", "go"}
# "Describe what's around me" questions get a full description, people first.
DESCRIBE_WORDS = {"describe", "surroundings", "around", "scene", "room", "everything", "important",
                  "near", "nearby", "notice", "happening",
                  "explain", "where am i"}
DESCRIBE_PHRASES = ("in front of me", "what can you see", "what do you see", "what's ahead",
                    "what you see", "looking at", "should know", "should i know", "anything here",
                    "anything there", "what's near", "what is near", "tell me what",
                    "what is ahead", "look around", "what's there", "what is there", "what's here",
                    "what is here", "where am i", "what's going on", "what is going on")
DESCRIBE_CHECK = (
    "Explain the important things you can clearly see, most important first, as a guide would to "
    "someone who cannot see the scene. In this order: one, anything in their way or that they "
    "could trip on or walk into; two, people near them, where they are, what they are doing and "
    "whether they are facing them, never leaving out a person who is close or only partly in the "
    "picture; three, things that help them find their way, such as doors, stairs or written signs. "
    "For each thing, say where it is, roughly how far away, and in a few words why it matters. "
    "Add one useful detail you can clearly see, such as its size, colour, whether a door is open "
    "or closed, which way stairs go, what a sign says, or what a person is wearing. Only include "
    "things that are definitely in this picture; if you are unsure about something, leave it out "
    "or describe its shape and position without naming it. People are the exception: mention "
    "every person you can see, even partly. Do not say what kind of place this is unless they ask. "
    "Leave out background things such as pipes, vents, wires, lights, shelves, posters, plants, "
    "decorations, wall colours and small objects, unless they are in their way. Describe people only by what is visible; do not try to say who someone is or guess "
    "personal traits such as ethnicity."
)
# Every other camera question gets this reminder, so important things are never skipped.
GENERAL_CHECK = (
    "Answer their question about the picture, with one useful detail that helps them picture it, "
    "such as its size, colour or whether it is open or closed. Then, in a sentence, mention "
    "anything important for getting around that is visible: something in their way, a person "
    "close by, a vehicle, or a door, stairs or a sign, each with where it is."
)
# Questions about people get a check focused on them.
PEOPLE_WORDS = {"who", "person", "people", "someone", "anyone", "anybody", "somebody", "man",
                "woman", "child", "kid", "they", "he", "she", "wearing", "face", "crowd"}
PEOPLE_CHECK = (
    "Look carefully for every person in the picture, including anyone close to the camera or only "
    "partly visible. For each, say where they are, roughly how far away, what they are doing, "
    "whether they are facing the camera, and what they are wearing. Describe only what is "
    "visible; do not try to say who someone is or guess personal traits such as ethnicity."
)
PATH_CHECK = (
    "Check carefully before answering. The bottom of the picture is the ground directly in front "
    "of them, where they will walk. Name every object, person, step, kerb, edge, slope, cable, "
    "bag, box, piece of furniture or anything else on or near that ground, and say where it is "
    "and roughly how far away. Only say the way ahead looks clear if the floor ahead is visible "
    "in the picture and there is truly nothing on it. If the floor is not visible, say you cannot "
    "see the ground and ask them to tilt the camera down."
)
# Answers that claim nothing is in the way. These get softened, because the camera can miss things.
CLEAR_CLAIM = re.compile(
    r"\b(path|way|route|floor|ground|area|space)\b[^.]*\b(is|looks|appears|seems)\b[^.]*\b(clear|empty|free)\b"
    r"|\bnothing (is |seems |appears )?(in|blocking|ahead|in front|on the)\b"
    r"|\bno (obstacles|obstructions|objects|hazards)\b|\bclear path\b|\bunobstructed\b"
    r"|\bnothing (there|ahead|around)\b")
CLEAR_ANSWER = ("From what the camera shows, I can't see anything in your way, but the camera can "
                "miss things, so please check with your cane.")
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

# Things Whisper is known to "hear" in pure noise
HALLUCINATIONS = {"you", "thanks for watching", "thank you for watching", "please subscribe",
                  "subscribe", "bye", "so", "um", "uh"}

# Words people say when they interrupt, removed from the start of the new request
FILLER_STARTS = ["hey acuity", "hey a cuity", "hey equity", "acuity", "a cuity", "accuity",
                 "acuty", "aquity", "equity", "be quiet", "shush", "enough", "pause", "cancel",
                 "hold on", "hang on", "never mind", "nevermind", "excuse me", "no wait",
                 "stop", "wait", "actually", "sorry", "okay", "ok", "hey", "no", "um", "uh"]

history = []            # text-only memory of the last few turns, so follow-up questions work
pending_audio = None    # what the user said while interrupting, waiting to be handled
piper_voice = None      # the voice, loaded once so it doesn't reload for every sentence
speaker = None          # the continuous audio output (Speaker)
synth_lock = threading.Lock()
file_counter = count()
reminder_counter = count()
camera = None
active_model = "gemma3:4b"   # the vision model in use (chosen at start-up)
whisper_model = None    # speech recognition, shared so it can check for stop words while talking
focus = None            # VoiceFocus, created at start-up


# =========================== Focusing on the speaker ===========================

def _db(power):
    return 10.0 * np.log10(power + 1e-12)


def _smooth(m, k_time, k_freq):
    """Blurs a (time, frequency) mask a little so the noise removal doesn't sound bubbly."""
    def box(a, k, axis):
        if k <= 1:
            return a
        pad = [(0, 0)] * a.ndim
        pad[axis] = (k // 2, k - 1 - k // 2)
        a = np.pad(a, pad, mode="edge")
        c = np.cumsum(a, axis=axis)
        zero = np.zeros_like(np.take(c, [0], axis=axis))
        c = np.concatenate([zero, c], axis=axis)
        n = c.shape[axis]
        return (np.take(c, range(k, n), axis=axis) - np.take(c, range(0, n - k), axis=axis)) / k
    return box(box(m, k_time, 0), k_freq, 1)


class VoiceFocus:
    """
    Learns the background sound of the room and uses it to:
      - decide whether a 0.1 second block of sound is someone talking (is it voice-like,
        and clearly above the background?), and
      - remove that background from a recording before it is transcribed.
    """

    FFT = 512
    HOP = 256

    def __init__(self):
        self.window = np.hanning(BLOCK)
        freqs = np.fft.rfftfreq(BLOCK, 1 / SAMPLE_RATE)
        self.band = (freqs >= SPEECH_BAND[0]) & (freqs <= SPEECH_BAND[1])
        self.noise_power = None                    # average background spectrum
        self.noise_audio = deque(maxlen=30)        # the last 3 seconds of pure background

        # For noise removal (shorter frames give a cleaner result)
        self.stft_window = np.sqrt(np.hanning(self.FFT + 1)[:-1])
        self.stft_freqs = np.fft.rfftfreq(self.FFT, 1 / SAMPLE_RATE)

    # ---- Per-block decisions while recording ----

    def _power(self, block):
        x = np.asarray(block, dtype=np.float32).flatten()
        if x.size != BLOCK:
            x = np.resize(x, BLOCK)
        return np.abs(np.fft.rfft(x * self.window)) ** 2

    def learn_noise(self, block, power=None):
        """Feeds a block that is known to be background into the noise picture."""
        p = self._power(block) if power is None else power
        if self.noise_power is None:
            self.noise_power = p
        else:
            self.noise_power = 0.9 * self.noise_power + 0.1 * p
        self.noise_audio.append(np.asarray(block, dtype=np.float32).flatten().copy())

    def analyse(self, block):
        """
        Returns (is_voice, level_db, snr_db, power).
        A voice is clearly louder than the background in the speech range AND has the
        "peaky" pattern of a voice, rather than the flat hiss of a fan or traffic.
        """
        p = self._power(block)
        band = p[self.band]
        level_db = _db(band.sum())
        if self.noise_power is None:
            snr_db = 99.0
        else:
            snr_db = level_db - _db(self.noise_power[self.band].sum())
        flatness = np.exp(np.mean(np.log(band + 1e-12))) / (np.mean(band) + 1e-12)
        is_voice = snr_db > SPEECH_SNR_DB and flatness < 0.3
        return is_voice, level_db, snr_db, p

    def background_db(self):
        return None if self.noise_power is None else _db(self.noise_power[self.band].sum())

    # ---- Cleaning a finished recording ----

    def _stft(self, x):
        x = np.pad(x, (self.FFT, self.FFT))
        frames = np.lib.stride_tricks.sliding_window_view(x, self.FFT)[:: self.HOP]
        return np.fft.rfft(frames * self.stft_window, axis=1)

    def _istft(self, spec, length):
        frames = np.fft.irfft(spec, n=self.FFT, axis=1) * self.stft_window
        out = np.zeros((frames.shape[0] - 1) * self.HOP + self.FFT, dtype=np.float32)
        for i, f in enumerate(frames):
            out[i * self.HOP: i * self.HOP + self.FFT] += f
        return out[self.FFT: self.FFT + length]

    def reduce_noise(self, audio):
        """Turns down anything at or below the learned background level (spectral gating)."""
        audio = np.asarray(audio, dtype=np.float32).flatten()
        if NOISE_REDUCTION <= 0 or len(self.noise_audio) < 3 or audio.size < self.FFT:
            return audio

        noise = np.concatenate(self.noise_audio)
        noise_db = 20 * np.log10(np.abs(self._stft(noise)) + 1e-9)
        threshold = noise_db.mean(axis=0) + 1.5 * noise_db.std(axis=0)

        spec = self._stft(audio)
        sig_db = 20 * np.log10(np.abs(spec) + 1e-9)
        mask = (sig_db > threshold[None, :]).astype(np.float32)
        mask = _smooth(mask, k_time=5, k_freq=3)

        gain = 1.0 - NOISE_REDUCTION * (1.0 - mask)
        gain[:, self.stft_freqs < HIGHPASS_HZ] = 0.0
        return self._istft(spec * gain, audio.size)


def keep_main_speaker(audio):
    """
    Finds the stretches of speech in the recording and keeps only those about as loud as
    the loudest one, which is the person closest to the microphone (the one asking).
    Returns (audio, number_of_speech_stretches_found) or (audio, None) if this step
    isn't available.
    """
    if not FOCUS_ON_MAIN_SPEAKER:
        return audio, None
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        options = VadOptions(threshold=0.4, min_speech_duration_ms=150,
                             min_silence_duration_ms=300, speech_pad_ms=200)
        stamps = get_speech_timestamps(audio, options)
    except Exception as e:
        if DEBUG_LEVELS:
            print("(speaker focus not available:", e, ")")
        return audio, None

    if not stamps:
        return audio, 0

    levels = []
    for s in stamps:
        seg = audio[s["start"]: s["end"]]
        levels.append(_db(float(np.mean(seg ** 2))) if seg.size else -120.0)
    loudest = max(levels)

    gap = np.zeros(int(0.25 * SAMPLE_RATE), dtype=np.float32)
    kept, dropped = [], 0
    for s, level in zip(stamps, levels):
        if level >= loudest - MAIN_SPEAKER_DB:
            if kept:
                kept.append(gap)
            kept.append(audio[s["start"]: s["end"]])
        else:
            dropped += 1
    if DEBUG_LEVELS and dropped:
        print(f"(left out {dropped} quieter bit(s) of speech from someone else)")
    return np.concatenate(kept), len(stamps)


# =========================== Camera (kept open for speed) ===========================

def sharpness(frame):
    """Higher = sharper. Used to skip blurry frames caused by hand movement."""
    small = cv2.resize(frame, (320, 180))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


class Camera:
    """Keeps the webcam open in the background so a picture is available instantly."""

    def __init__(self, index):
        self.cap = cv2.VideoCapture(index)
        if self.cap.isOpened():
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)        # always the newest picture, not an old one
        self.frames = deque(maxlen=8)     # (time, frame, sharpness) for the last few frames
        self.scores = deque(maxlen=90)    # sharpness over the last few seconds, to judge blur against
        self.lock = threading.Lock()
        self.running = self.cap.isOpened()
        if self.running:
            w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            print(f"(camera open at {w}x{h})")
            threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.running:
            ok, frame = self.cap.read()
            if ok:
                if MIRROR_CAMERA:
                    frame = cv2.flip(frame, 1)
                score = sharpness(frame)
                with self.lock:
                    self.frames.append((time.time(), frame, score))
                    self.scores.append(score)
            else:
                time.sleep(0.05)

    def snapshot(self):
        """The sharpest of the last few frames, straight away. Returns (frame, sharpness) or (None, 0)."""
        with self.lock:
            frames = list(self.frames)
        if not frames:
            return None, 0.0
        _, frame, score = max(frames, key=lambda f: f[2])
        return frame.copy(), score

    def is_blurry(self, score):
        """Blurry compared with how sharp this view normally is (scenes differ a lot, so no fixed number)."""
        with self.lock:
            scores = list(self.scores)
        if len(scores) < 10:
            return False
        return score < BLUR_RATIO * float(np.percentile(scores, 75))

    def steady_frame(self, wait=0.5):
        """
        Like snapshot, but if the picture is blurry (a moving hand), waits up to `wait`
        seconds for a sharper one. Returns (frame, sharpness).
        """
        best, best_score = self.snapshot()
        deadline = time.time() + wait
        while self.is_blurry(best_score) and time.time() < deadline:
            time.sleep(0.05)
            frame, score = self.snapshot()
            if score > best_score:
                best, best_score = frame, score
        return best, best_score

    def close(self):
        self.running = False
        time.sleep(0.1)
        self.cap.release()


def enhance(frame):
    """Brightens dim pictures and adds contrast to flat ones, so details and text stand out."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if gray.mean() > 70 and gray.std() > 45:
        return frame                                   # already well lit with good contrast
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    if gray.mean() < 70:                                   # dim: lift the shadows gently
        gamma = 0.5 if gray.mean() < 40 else 0.7
        table = (((np.arange(256) / 255.0) ** gamma) * 255).astype(np.uint8)
        l = cv2.LUT(l, table)
    l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


_detectors = None


def people_detectors():
    """Loads OpenCV's face and person detectors once. Anything missing is simply skipped."""
    global _detectors
    if _detectors is None:
        _detectors = {}
        try:
            path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
            face = cv2.CascadeClassifier(path)
            if not face.empty():
                _detectors["face"] = face
        except Exception:
            pass
        try:
            hog = cv2.HOGDescriptor()
            hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
            _detectors["body"] = hog
        except Exception:
            pass
        if DEBUG_LEVELS:
            print(f"(people detectors available: {', '.join(_detectors) or 'none'})")
    return _detectors


def side_of(x_centre):
    return "on your left" if x_centre < 0.35 else "on your right" if x_centre > 0.65 else "ahead of you"


def find_people(frame):
    """
    Returns a list of people found, each {"side": "on your left" / "ahead of you" / ..., "close": bool}.
    Faces catch people close by; the body detector catches whole people standing further away.
    """
    if not PEOPLE_DETECTOR:
        return []
    found = []
    try:
        small = cv2.resize(frame, (640, int(640 * frame.shape[0] / frame.shape[1])))
        h, w = small.shape[:2]
        det = people_detectors()
        boxes = []
        if "face" in det:
            gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
            for (x, y, fw, fh) in det["face"].detectMultiScale(gray, 1.1, 6, minSize=(28, 28)):
                boxes.append((x, y, fw, fh, fw / w > 0.12))
        if "body" in det:
            rects, weights = det["body"].detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.05)
            for (x, y, bw, bh), wt in zip(rects, np.ravel(weights) if len(rects) else []):
                if float(wt) < 0.6:
                    continue
                # skip a body whose face was already found
                if any(fx >= x and fx + fw2 <= x + bw and fy >= y and fy <= y + bh
                       for fx, fy, fw2, _, _ in boxes):
                    continue
                boxes.append((x, y, bw, bh, bh / h > 0.75))
        for (x, y, bw, bh, close) in boxes:
            found.append({"side": side_of((x + bw / 2) / w), "close": bool(close)})
    except Exception as e:
        if DEBUG_LEVELS:
            print("(people detector problem:", e, ")")
    return found


def people_note(people):
    if not people:
        return ""
    parts = [f"one {'close to the camera' if p['close'] else 'further away'} {p['side']}" for p in people]
    return ("A person detector suggests there may be people here: " + "; ".join(parts) +
            ". Look for them in the picture and describe each person you can actually see.")


def to_jpeg(frame, size=896):
    """Shrinks the picture to the size the model looks at and turns it into JPEG bytes."""
    h, w = frame.shape[:2]
    scale = min(1.0, size / max(h, w))      # gemma3 looks at images at 896 pixels
    if scale < 1.0:
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return buffer.tobytes() if ok else None


def centre_zoom(frame):
    """The middle of the picture at twice the detail, for reading signs and small text."""
    h, w = frame.shape[:2]
    return frame[h // 4: h - h // 4, w // 4: w - w // 4]


# The picture taken the moment you finished your question (so it matches what you asked about)
question_frame = {"frame": None, "score": 0.0, "time": 0.0}


def remember_question_frame():
    if camera and camera.running:
        frame, score = camera.snapshot()
        question_frame.update(frame=frame, score=score, time=time.time())


def grab_frame(question):
    """
    Returns (list_of_jpegs, brightness, note_for_the_model).
    Uses the picture from when you finished speaking if it is sharp; otherwise waits a moment
    for a steadier one. Adds a zoomed-in view when you've asked to read something.
    """
    if not camera or not camera.running:
        return None, 0, "", []
    frame, score = question_frame["frame"], question_frame["score"]
    if frame is None or time.time() - question_frame["time"] > 5 or camera.is_blurry(score):
        frame, score = camera.steady_frame()
    if frame is None:
        return None, 0, "", []

    brightness = float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean())
    frame = enhance(frame)
    images = [to_jpeg(frame)]
    notes = []
    words = set(re.findall(r"[a-z']+", normalise(question)))
    if ZOOM_FOR_READING and words & READ_WORDS:
        images.append(to_jpeg(centre_zoom(frame)))
        notes.append("The second picture is a zoomed-in view of the centre of the first, for reading small text.")
    elif words & PATH_WORDS:
        h = frame.shape[0]
        images.append(to_jpeg(frame[h // 2:, :]))
        notes.append("The second picture is the bottom half of the first in more detail: the ground "
                     "directly in front of them.")
    elif DETAIL_FOR_FINDING and words & FIND_WORDS:
        w = frame.shape[1]
        images.append(to_jpeg(frame[:, : int(w * 0.55)]))
        images.append(to_jpeg(frame[:, int(w * 0.45):]))
        notes.append("The second and third pictures are the left half and the right half of the first, "
                     "in more detail. Use them to judge exactly where things are.")
    people = find_people(frame)
    if people:
        notes.append(people_note(people))
    if words & PATH_WORDS:
        notes.append(PATH_CHECK)
    elif is_describe_question(question):
        notes.append(DESCRIBE_CHECK)
    elif words & PEOPLE_WORDS:
        notes.append(PEOPLE_CHECK)
    else:
        notes.append(GENERAL_CHECK)
    if SAVE_DEBUG_IMAGE and images[0]:
        try:
            with open(os.path.join(HERE, "last_view.jpg"), "wb") as f:
                f.write(images[0])
        except OSError:
            pass
    return [i for i in images if i], brightness, " ".join(notes), people


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


def voice_sample_rate():
    """Reads the voice's sample rate from its .onnx.json file (22050 if it can't tell)."""
    try:
        with open(os.path.join(HERE, VOICE + ".onnx.json")) as f:
            return int(json.load(f)["audio"]["sample_rate"])
    except Exception:
        return 22050


def read_wav(source):
    """Reads a wav (file path or bytes) into float audio. Returns (audio, sample_rate)."""
    if isinstance(source, (bytes, bytearray)):
        source = io.BytesIO(source)
    with wave.open(source, "rb") as wf:
        rate, width, channels = wf.getframerate(), wf.getsampwidth(), wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16 if width == 2 else np.uint8).astype(np.float32)
    audio = audio / 32768.0 if width == 2 else (audio - 128) / 128.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def ready_to_play(audio, rate):
    """
    Converts to the speaker's sample rate, trims the long silences Piper puts at the start
    and end of every clip, and adds a short natural pause instead.
    """
    out_rate = speaker.rate if speaker else rate
    if rate != out_rate and audio.size:
        n = int(audio.size * out_rate / rate)
        audio = np.interp(np.linspace(0, audio.size - 1, n), np.arange(audio.size), audio).astype(np.float32)
    if audio.size:
        level = np.abs(audio)
        loud = np.nonzero(level > max(0.008, 0.02 * float(level.max())))[0]
        if loud.size:
            start = max(0, loud[0] - int(0.03 * out_rate))
            end = min(audio.size, loud[-1] + int(0.06 * out_rate))
            audio = audio[start:end]
    audio = audio.astype(np.float32)
    fade = min(audio.size // 2, int(0.008 * out_rate))
    if fade > 0:                                   # fade in and out over 8 ms, so no clicks
        audio[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        audio[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    return np.concatenate([audio, np.zeros(int(SENTENCE_GAP * out_rate), dtype=np.float32)])


def synth_wav_bytes(text):
    """Turns text into wav bytes with Piper. Returns None if Piper isn't working."""
    with synth_lock:
        if piper_voice is not None:
            try:
                buffer = io.BytesIO()
                with wave.open(buffer, "wb") as wf:
                    if hasattr(piper_voice, "synthesize_wav"):
                        piper_voice.synthesize_wav(text, wf)
                    else:
                        piper_voice.synthesize(text, wf)
                return buffer.getvalue()
            except Exception as e:
                print("(Piper in-memory failed:", e, ")")
        try:
            path = os.path.join(TMP_DIR, f"s_{next(file_counter)}.wav")
            subprocess.run([sys.executable, "-m", "piper", "-m", VOICE, "-f", path, "--", text],
                           cwd=HERE, check=True, capture_output=True)
            with open(path, "rb") as f:
                data = f.read()
            os.remove(path)
            return data
        except Exception as e:
            print("(Piper command failed, using the Mac voice instead:", e, ")")
            return None


def synth_audio(text):
    """Text to audio ready for the speaker, or None if it has to fall back to the Mac voice."""
    data = synth_wav_bytes(text)
    return ready_to_play(*read_wav(data)) if data else None


def synth_cached(text):
    """Like synth_audio, but saves the audio so repeated phrases (greeting, help) are instant."""
    path = os.path.join(CACHE_DIR, hashlib.md5((VOICE + text).encode()).hexdigest() + ".wav")
    if not os.path.exists(path):
        data = synth_wav_bytes(text)
        if not data:
            return None
        with open(path, "wb") as f:
            f.write(data)
    return ready_to_play(*read_wav(path))


class Speaker:
    """
    Plays speech and turn sounds. Sentences are added as soon as they are ready and play
    back to back with no gap. It uses a generous sound buffer so it never runs dry while the
    computer is busy (a dry buffer is what makes crackling or static), and it closes the
    audio output when it has nothing to say, so nothing hisses in the background.
    """

    IDLE_CLOSE_SECONDS = 1.0

    def __init__(self, rate):
        self.rate = rate
        self.lock = threading.Lock()
        self.chunks = deque()
        self.offset = 0
        self.last_sound = 0.0
        self.underflows = 0
        self.stream = None

    def _open(self):
        """Opens the audio output (only while there is something to play)."""
        if self.stream is not None and self.stream.active:
            return
        if self.stream is not None:
            try:
                self.stream.close()
            except Exception:
                pass
        self.last_sound = time.time()
        self.stream = sd.OutputStream(samplerate=self.rate, channels=1, dtype="float32",
                                      blocksize=1024, latency="high", callback=self._callback)
        self.stream.start()

    def _callback(self, outdata, frames, time_info, status):
        if status and getattr(status, "output_underflow", False):
            self.underflows += 1
        out = outdata[:, 0]
        filled = 0
        with self.lock:
            while filled < frames and self.chunks:
                chunk = self.chunks[0]
                take = min(frames - filled, chunk.size - self.offset)
                out[filled: filled + take] = chunk[self.offset: self.offset + take]
                filled += take
                self.offset += take
                if self.offset >= chunk.size:
                    self.chunks.popleft()
                    self.offset = 0
        out[filled:] = 0.0
        now = time.time()
        if filled:
            self.last_sound = now
        elif now - self.last_sound > self.IDLE_CLOSE_SECONDS:
            raise sd.CallbackStop             # nothing to say: switch the output off

    def add(self, audio):
        if audio is None or not len(audio):
            return
        audio = np.clip(np.asarray(audio, dtype=np.float32).flatten(), -1.0, 1.0)
        with self.lock:
            self.chunks.append(audio)
        self._open()

    def clear(self):
        """Stops talking straight away, with a very quick fade so it doesn't click."""
        with self.lock:
            if self.chunks:
                rest = self.chunks[0][self.offset: self.offset + int(0.01 * self.rate)]
                fade = (rest * np.linspace(1, 0, rest.size)).astype(np.float32)
                self.chunks.clear()
                self.chunks.append(fade)
            self.offset = 0

    def busy(self):
        with self.lock:
            waiting = bool(self.chunks)
        return waiting or time.time() - self.last_sound < 0.25     # allow for the sound still leaving

    def wait(self):
        while self.busy():
            time.sleep(0.02)

    def report(self):
        if DEBUG_LEVELS and self.underflows:
            print(f"(audio buffer ran dry {self.underflows} times - this causes crackling)")
            self.underflows = 0

    def close(self):
        try:
            if self.stream is not None:
                self.stream.stop()
                self.stream.close()
        except Exception:
            pass


def clean_for_speech(text):
    for ch in "*#_`":
        text = text.replace(ch, "")
    return " ".join(text.split())


def rms(block):
    return float(np.sqrt(np.mean(block ** 2)))


def open_mic():
    return sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                          blocksize=BLOCK, device=INPUT_DEVICE)


# Work started on your words during the pause at the end of your question (saves time)
early_result = {"job": None, "length": -1}
used_early_job = None   # the early job whose transcription was used for the current question


def is_command(text):
    """Spoken commands (help, repeat, goodbye...) are handled directly, never by the model."""
    n = normalise(text or "")
    return (not n or n in EXIT_WORDS or n in HELP_WORDS or n in REPEAT_WORDS or n in NO_WORDS
            or n in THANKS_WORDS)


def cancel_early(job):
    """Throws away an early start (they carried on talking, or asked something else)."""
    if job is None:
        return
    job["cancelled"] = True
    answer = job.get("answer")
    if answer:
        answer["stop"].set()


def start_early_transcription(chunks):
    """
    Starts transcribing what you've said so far, in the background, while it waits to be sure
    you've finished. If that works, it also starts working out the answer, so it is often ready
    by the time the pause is over. Both are thrown away if you carry on talking.
    """
    if whisper_model is None:
        return None
    audio = np.concatenate(chunks).flatten()
    job = {"result": None, "done": threading.Event(), "cancelled": False, "answer": None}
    remember_question_frame()              # the camera view as you finish asking

    def run():
        try:
            job["result"] = text = transcribe_now(whisper_model, audio)
            if (SPECULATIVE_ANSWERS and not job["cancelled"] and isinstance(text, str)
                    and not is_command(text)):
                answer = {"question": text, "out_q": queue.Queue(), "stop": threading.Event(),
                          "info": {}, "started": time.time()}
                job["answer"] = answer
                threading.Thread(target=produce, daemon=True,
                                 args=(text, answer["out_q"], answer["stop"], answer["info"])).start()
        except Exception as e:
            print("(early transcription failed:", e, ")")
        finally:
            job["done"].set()

    threading.Thread(target=run, daemon=True).start()
    return job


def discard_unused_early():
    """Stops an early answer that the last turn didn't use (a command, or they said "stop")."""
    global used_early_job
    cancel_early(used_early_job)
    used_early_job = None


def take_early_answer(question):
    """Returns the answer already being worked out for exactly this question, or None."""
    global used_early_job
    job, used_early_job = used_early_job, None
    if job is None:
        return None
    answer = job.get("answer")
    if answer and answer["question"] == question and not answer["stop"].is_set():
        return answer
    cancel_early(job)
    return None


def follow_speaker(stream, chunks, speaker_db):
    """
    Keeps recording from an open stream until the person asking stops talking.
    Only voice-like sound within SPEAKER_DROP_DB of how loud they are keeps it going,
    so a TV or a conversation further away doesn't make it listen forever.
    During the final pause it already starts transcribing, so the answer comes sooner.
    """
    silent_for = 0.0
    early_job = None
    begin = time.time()
    while time.time() - begin < MAX_LISTEN_SECONDS:
        data, _ = stream.read(BLOCK)
        chunks.append(data.copy())
        is_voice, level_db, _, _ = focus.analyse(data)
        if is_voice and level_db > speaker_db - SPEAKER_DROP_DB:
            silent_for = 0.0
            cancel_early(early_job)           # they carried on talking, so that early start is out of date
            early_job = None
            # Track how loud you usually are. It rises quickly to your normal voice and
            # settles slowly, so one loud word or cough doesn't throw it off.
            rate = 0.5 if level_db > speaker_db else 0.1
            speaker_db += rate * (level_db - speaker_db)
        else:
            silent_for += BLOCK_SECONDS
            if early_job is None and silent_for >= EARLY_TRANSCRIBE_SECONDS:
                early_job = start_early_transcription(chunks)
        if silent_for >= SILENCE_SECONDS:
            break

    remember_question_frame()                 # the camera view at the moment you finished asking
    audio = np.concatenate(chunks).flatten()
    if early_job is not None:
        early_job["length"] = audio.size
    early_result.update(job=early_job, length=audio.size)
    return audio


def quick_transcribe(audio):
    """A fast, rough transcription, only used to spot stop words while the guide is talking."""
    if whisper_model is None or audio.size == 0:
        return ""
    clean = focus.reduce_noise(audio)
    peak = float(np.percentile(np.abs(clean), 99.9))
    if peak < 1e-4:
        return ""
    clean = np.clip(clean / peak * 0.7, -1.0, 1.0).astype(np.float32)
    segments, _ = whisper_model.transcribe(
        clean, language="en", beam_size=1, temperature=0.0,
        condition_on_previous_text=False, without_timestamps=True, vad_filter=False,
        initial_prompt="Hey Acuity. Stop. Wait. Hold on.",
    )
    return " ".join(s.text.strip() for s in segments)


def heard_stop_word(text, playing_text=""):
    """
    True if the person said the guide's name anywhere, or started with a stop word.
    Words the guide itself is saying right now are skipped, so its own voice coming
    through the speakers ("the bus stop is ahead") can't stop it.
    """
    n = normalise(text)
    if not n:
        return False
    playing = " " + normalise(playing_text) + " "
    padded = " " + n + " "
    for name in WAKE_NAMES:
        if f" {name} " in padded and f" {name} " not in playing:
            return True
    words = n.split()
    while words and words[0] in ("hey", "okay", "ok", "oh", "um", "uh", "no", "please", "sorry"):
        words = words[1:]
    start = " ".join(words[:3]) + " "
    for word in STOP_WORDS:
        if start.startswith(word + " ") and f" {word} " not in playing:
            return True
    return False


def listen_while_playing(player, playing_text=""):
    # playing_text can be a function, because an answer grows while it is being spoken
    """
    Listens to the microphone while the guide is talking. It does NOT stop for noise or
    for other people talking. When someone speaks, it transcribes what they say in the
    background and only stops if it hears the guide's name or a stop word.
    Returns what the person said if they stopped it, or None if it played to the end.
    """
    preroll = deque(maxlen=PREROLL_BLOCKS)    # so the first word isn't lost
    window = deque(maxlen=3)
    utterance = None                          # audio of what someone is saying right now
    quiet_for = 0.0
    checked_blocks = 0
    final_checked = False
    check = {"busy": False, "hit": False, "text": ""}
    peak = 0.0

    def run_check(audio):
        try:
            text = quick_transcribe(audio)
            check["text"] = text
            current = playing_text() if callable(playing_text) else playing_text
            if heard_stop_word(text, current):
                check["hit"] = True
        except Exception as e:
            print("(could not check for a stop word:", e, ")")
        finally:
            check["busy"] = False

    def start_check():
        nonlocal checked_blocks
        check["busy"] = True
        checked_blocks = len(utterance)
        audio = np.concatenate(utterance).flatten()
        threading.Thread(target=run_check, args=(audio,), daemon=True).start()

    with open_mic() as stream:
        # Keep going while it talks, or while someone is mid-sentence and we're still checking
        while player.poll() is None or utterance is not None:
            data, _ = stream.read(BLOCK)
            level = rms(data)
            peak = max(peak, level)
            is_voice, level_db, _, _ = focus.analyse(data)
            loud_voice = is_voice and level > BARGE_IN_LEVEL

            if check["hit"]:
                if player.poll() is None:
                    player.terminate()
                    try:
                        player.wait(timeout=1)
                    except Exception:
                        pass
                print(f"(stopped: you said \"{check['text']}\")")
                if CUE_WHEN_HEARD:
                    cue("heard", wait=False)
                utterance.append(data.copy())
                return follow_speaker(stream, utterance, level_db)

            if utterance is None:
                preroll.append(data.copy())
                window.append(loud_voice)
                if sum(window) >= BARGE_IN_BLOCKS:
                    utterance = list(preroll)
                    quiet_for = 0.0
                    checked_blocks = 0
                    final_checked = False
                    window.clear()
                continue

            utterance.append(data.copy())
            quiet_for = 0.0 if is_voice else quiet_for + BLOCK_SECONDS
            seconds = len(utterance) * BLOCK_SECONDS

            # Check what they've said so far, every half second, near the start of what they say
            if (not check["busy"] and seconds <= KEYWORD_LISTEN_SECONDS
                    and len(utterance) - checked_blocks >= 5):
                start_check()

            # They've stopped talking (or it's gone on too long to be a command)
            finished = quiet_for >= 0.8 or seconds > KEYWORD_LISTEN_SECONDS + 1
            if finished and not check["busy"]:
                if not final_checked and seconds <= KEYWORD_LISTEN_SECONDS + 1:
                    final_checked = True
                    start_check()                 # one last look at the whole thing
                    continue
                if DEBUG_LEVELS and check["text"]:
                    print(f"(heard \"{check['text']}\" while talking, no stop word, carrying on)")
                utterance = None
                check["text"] = ""

    if DEBUG_LEVELS:
        print(f"(loudest sound while I spoke: {peak:.3f}; check level is {BARGE_IN_LEVEL})")
    return None


class SpeakingTurn:
    """
    One turn of the guide talking (which may be several sentences). It behaves like a running
    player for listen_while_playing: poll() is None while it is still talking, or still
    waiting for more of the answer to arrive.
    """

    def __init__(self):
        self.done_adding = False
        self.stopped = False

    def poll(self):
        if self.stopped or (self.done_adding and not speaker.busy()):
            return 0
        return None

    def terminate(self):
        self.stopped = True
        speaker.clear()

    def wait(self, timeout=None):
        pass


def speak_turn(pieces):
    """
    Plays (text, audio) pieces back to back through the speaker, while listening for
    "hey Acuity" or a stop word. Returns (texts_spoken, what_the_user_said_or_None).
    """
    turn = SpeakingTurn()
    texts = []

    def feed():
        try:
            for text, audio in pieces:
                if turn.stopped:
                    break
                if audio is None and text:
                    subprocess.run(["say", text])          # Piper failed: the Mac voice instead
                else:
                    speaker.add(audio)
                if text:
                    texts.append(text)
        except Exception as e:
            print("(problem while speaking:", e, ")")
        finally:
            turn.done_adding = True

    threading.Thread(target=feed, daemon=True).start()
    if BARGE_IN:
        captured = listen_while_playing(turn, lambda: " ".join(texts))
    else:
        while turn.poll() is None:
            time.sleep(0.03)
        captured = None
    return texts, captured


def speak(text):
    """Speaks a fixed phrase (greeting, help, short replies)."""
    global pending_audio
    text = clean_for_speech(text)
    print("Assistant:", text)
    _, captured = speak_turn([("", CUE_AUDIO.get("my_turn")), (text, synth_cached(text))])
    if captured is not None:
        pending_audio = captured
    time.sleep(0.1)   # let the room go quiet so we don't hear ourselves


# Each cue is a list of (pitch in Hz, length in seconds)
CUES = {
    "your_turn": [(660, 0.09), (990, 0.13)],
    "my_turn":   [(990, 0.09), (660, 0.13)],
    "heard":     [(440, 0.05)],
    "got_it":    [(1175, 0.07)],
}


CUE_AUDIO = {}


def make_cue_sounds():
    """Creates the turn sounds in memory, at the speaker's sample rate."""
    rate = speaker.rate if speaker else 22050
    for name, notes in CUES.items():
        parts = []
        for pitch, length in notes:
            t = np.arange(int(rate * length)) / rate
            tone = np.sin(2 * np.pi * pitch * t) + 0.25 * np.sin(2 * np.pi * 2 * pitch * t)
            fade = min(len(t) // 4, int(rate * 0.012))
            env = np.ones_like(t)
            env[:fade] = np.linspace(0, 1, fade)                  # soft start, no click
            env[-fade * 2:] = np.linspace(1, 0, fade * 2)         # soft end
            parts.append(tone * env)
            parts.append(np.zeros(int(rate * 0.025)))            # tiny gap between notes
        CUE_AUDIO[name] = (np.concatenate(parts) / 1.25 * CUE_VOLUME).astype(np.float32)
    CUE_AUDIO["my_turn"] = np.concatenate([CUE_AUDIO["my_turn"], np.zeros(int(rate * 0.08), np.float32)])


def cue(name, wait=True):
    """Plays one of the turn sounds. wait=False plays it without pausing the program."""
    if not SOUND_CUES or speaker is None or name not in CUE_AUDIO:
        return
    speaker.add(CUE_AUDIO[name])
    if wait:
        speaker.wait()


# =========================== Voice input (microphone + Whisper) ===========================

def calibrate_noise():
    """Listens to the room for a moment to learn what the background sounds like."""
    print("Learning the sound of the room for a moment, please stay quiet...")
    with open_mic() as stream:
        stream.read(BLOCK)                      # the first block is often a click, skip it
        for _ in range(20):
            data, _ = stream.read(BLOCK)
            focus.learn_noise(data)
    print(f"(background level {focus.background_db():.1f} dB)")


def record_question():
    """
    Waits for someone to start talking, then records until they stop.
    While waiting, it keeps updating its picture of the background noise.
    Returns audio, or None if nobody spoke.
    """
    preroll = deque(maxlen=PREROLL_BLOCKS)
    window = deque()          # the last few blocks: (audio, is_voice, level_db)
    begin = time.time()

    with open_mic() as stream:
        while time.time() - begin < WAIT_FOR_SPEECH_SECONDS:
            data, _ = stream.read(BLOCK)
            is_voice, level_db, snr_db, power = focus.analyse(data)

            if len(window) == START_BLOCKS + 1:
                preroll.append(window.popleft()[0])
            window.append((data.copy(), is_voice, level_db))

            # Voice in most of the last few blocks = someone has started talking.
            # (Real speech is choppy, so we don't require every block in a row.)
            voiced = [level for _, v, level in window if v]
            if len(voiced) >= START_BLOCKS:
                if DEBUG_LEVELS:
                    print(f"(voice heard, {snr_db:.0f} dB above the background)")
                if CUE_WHEN_HEARD:
                    cue("heard", wait=False)
                chunks = list(preroll) + [block for block, _, _ in window]
                return follow_speaker(stream, chunks, float(np.mean(voiced)))

            # Clearly just background: keep the noise picture up to date
            if not is_voice and snr_db < SPEECH_SNR_DB / 2:
                focus.learn_noise(data, power)
    return None


def save_wav(audio, name):
    try:
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
        with wave.open(os.path.join(HERE, name), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm.tobytes())
    except Exception:
        pass


last_answer = ""        # what the guide said last, so follow-up questions are recognised better


def whisper_prompt():
    """The hint for Whisper: the usual words, plus the end of what the guide just said,
    because people's follow-up questions usually reuse those words (door, platform 4...)."""
    parts = [WHISPER_HINT or "", last_answer[-200:]]
    return " ".join(p for p in parts if p).strip() or None


def transcribe(whisper, audio):
    """
    Turns your recording into text. If it already started on it during the pause at the end
    of your question (and you didn't say anything more after that), it uses that result.
    Returns None if the recording turned out to be only background noise, or an empty
    string if someone spoke but it couldn't make out the words.
    """
    global used_early_job
    job = early_result.get("job")
    early_result.update(job=None, length=-1)
    if job is not None and audio is not None and early_result_length_ok(job, audio):
        job["done"].wait(timeout=30)
        if job["done"].is_set():
            if DEBUG_LEVELS:
                print("(used the early transcription)")
            used_early_job = job
            return job["result"]
    cancel_early(job)
    return transcribe_now(whisper, audio)


def early_result_length_ok(job, audio):
    return job.get("length") == audio.size


def transcribe_now(whisper, audio):
    """Cleans the recording so only the person asking is left, then turns it into text."""
    if audio is None or audio.size == 0:
        return ""
    audio = np.asarray(audio, dtype=np.float32).flatten()
    audio = audio - float(np.mean(audio))           # remove any DC offset from the mic
    if SAVE_DEBUG_AUDIO:
        save_wav(audio, "last_question.wav")

    clean = focus.reduce_noise(audio)
    clean, found = keep_main_speaker(clean)

    peak = float(np.percentile(np.abs(clean), 99.9)) if clean.size else 0.0
    if peak < 1e-4:
        return ""
    clean = np.clip(clean / peak * 0.7, -1.0, 1.0).astype(np.float32)
    if SAVE_DEBUG_AUDIO:
        save_wav(clean, "last_question_clean.wav")

    segments, _ = whisper.transcribe(
        clean,
        language="en",
        beam_size=WHISPER_BEAM,
        temperature=0.0,
        condition_on_previous_text=False,
        without_timestamps=True,
        initial_prompt=whisper_prompt(),
        vad_filter=False,                 # already done above
    )

    # If the speech finder heard nothing, be much stricter about trusting the text
    no_speech_limit = 0.4 if found == 0 else 0.6
    parts = []
    for s in segments:
        if s.no_speech_prob > no_speech_limit and s.avg_logprob < -0.8:
            continue                      # probably just noise
        parts.append(s.text.strip())
    text = " ".join(parts).strip()

    t = normalise(text)
    if found == 0 and (not t or t in HALLUCINATIONS):
        return None                       # nobody was actually talking
    if len(t.split()) >= 5 and t in normalise(whisper_prompt() or ""):
        return ""                         # Whisper echoed its hint back
    return text


CPU_THREADS = max(1, min(8, (os.cpu_count() or 4)))   # use the Mac's cores for speech recognition


def load_whisper():
    print(f"Loading speech recognition '{WHISPER_SIZE}' (the first run downloads it, so use wifi)...")
    try:
        return WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)
    except Exception as e:
        print(f"(Could not load '{WHISPER_SIZE}': {e}. Falling back to small.en)")
        return WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)


# =========================== The model (answers arrive sentence by sentence) ===========================

def build_messages(question, images=None, note=""):
    """
    The system prompt and earlier turns always come first and stay the same, so Ollama can
    reuse its work on them. Only the newest message (and any picture) is new each time.
    """
    content = question if not note else f"({note})\n\nTheir question: {question}"
    user_message = {"role": "user", "content": content}
    if images:
        user_message["images"] = images
    # Camera questions get less of the old conversation, so old scenes don't creep into new answers
    recent = history[-4:] if images else history[-6:]
    return [{"role": "system", "content": SYSTEM_PROMPT}] + recent + [user_message]


def stream_sentences(messages, stop):
    """
    Asks the model and yields its answer piece by piece as it is written: whole sentences,
    except that a long first sentence is split at a comma so speaking can start sooner.
    """
    buf = ""
    first = True
    cut_off = False
    stream = ollama.chat(
        model=active_model,
        messages=messages,
        stream=True,
        keep_alive=-1,                           # keeps the model loaded, so it never has to reload
        options=MODEL_OPTIONS,
    )
    for chunk in stream:
        if stop.is_set():
            return
        buf += chunk["message"]["content"]
        reason = chunk.get("done_reason") if hasattr(chunk, "get") else getattr(chunk, "done_reason", None)
        if reason == "length":
            cut_off = True
        while True:
            m = re.search(r"[.!?]\s", buf)
            if not m and first and len(buf) > 40:
                comma = re.search(r"[,;:]\s", buf[40:])        # long first sentence: start at a comma
                if comma:
                    end = 40 + comma.end()
                    piece, buf = buf[:end].strip(), buf[end:]
                    first = False
                    if piece:
                        yield piece
                    continue
            if not m:
                break
            piece, buf = buf[:m.end()].strip(), buf[m.end():]
            first = False
            if piece:
                yield piece
    if not stop.is_set() and buf.strip():
        if cut_off and not re.search(r"[.!?]$", buf.strip()):
            return                            # ran out of words mid-sentence: don't say half a sentence
        yield buf.strip()


def remember(question, answer):
    history.append({"role": "user", "content": question})
    history.append({"role": "assistant", "content": answer})


# Things that make a warning worth saying. A caution sentence that names none of these is generic.
HAZARD_WORDS = {
    "step", "steps", "stair", "stairs", "kerb", "kerbs", "curb", "curbs", "edge", "gap", "hole",
    "drop", "slope", "ramp", "uneven", "wet", "slippery", "ice", "icy", "puddle", "obstacle",
    "obstacles", "pole", "post", "bollard", "sign", "bin", "bench", "chair", "table", "box",
    "car", "cars", "vehicle", "vehicles", "bus", "bike", "bicycle", "scooter", "truck", "van",
    "traffic", "road", "person", "people", "someone", "dog", "door", "glass", "branch", "cone",
    "barrier", "construction", "works", "platform", "train", "escalator", "low", "ceiling",
}
GENERIC_WARNINGS = re.compile(
    r"\b(be careful|careful|stay alert|stay safe|stay aware|remain alert|remain cautious|"
    r"be cautious|be aware|watch your step|take care|proceed with caution|use caution|"
    r"keep an eye out|pay attention to your surroundings|mind your step)\b")
NO_HAZARD_TALK = re.compile(
    r"\b(no|not any|don't see any|do not see any|can't see any|cannot see any|without)\b[^.]*"
    r"\b(hazards?|dangers?|obstacles?|obstructions?)\b")
SAFETY_QUESTION_WORDS = {"safe", "safety", "danger", "dangerous", "hazard", "hazards", "careful",
                         "risk", "obstacle", "obstacles", "clear", "trip"}


# The only words a purely generic warning is made of. If a warning sentence contains ANY other
# word (bags, cable, chair, "on the left"...), it might be about something real, so it is kept.
GENERIC_ONLY = {
    "please", "be", "careful", "stay", "alert", "safe", "aware", "remain", "cautious", "watch",
    "your", "step", "steps", "take", "care", "proceed", "with", "caution", "use", "keep", "an",
    "eye", "out", "pay", "attention", "to", "surroundings", "mind", "as", "you", "walk", "move",
    "moving", "walking", "go", "going", "around", "while", "when", "and", "so", "of", "the",
    "always", "also", "just", "remember", "make", "sure", "that", "it", "is", "important", "now",
    "carefully", "too", "here", "re", "you're", "are", "way", "along", "a", "bit",
}


def is_needless_warning(sentence, question):
    """
    True only for a sentence that is nothing but a generic warning ("Please be careful as you
    walk."). Anything that mentions a thing, place or direction is kept, because it might be
    a real hazard. Never removes anything when they asked about safety or their path.
    """
    q_words = set(re.findall(r"[a-z']+", normalise(question)))
    if q_words & (SAFETY_QUESTION_WORDS | PATH_WORDS):
        return False
    s = normalise(sentence)
    words = set(re.findall(r"[a-z']+", s))
    if NO_HAZARD_TALK.search(s) and words <= GENERIC_ONLY | {
            "no", "not", "any", "don't", "do", "see", "can't", "cannot", "i", "there", "hazards",
            "hazard", "dangers", "danger", "obstacles", "obstructions", "without", "visible"}:
        return True
    return bool(GENERIC_WARNINGS.search(s)) and words <= GENERIC_ONLY


# Kinds of place a small model likes to guess. A sentence that says "you're in a ..." or "this
# looks like a ..." one of these is removed, unless they asked where they are.
PLACE_NAMES = (
    r"(train |railway |tube |underground |subway |metro |bus |coach )?(station|terminal)|platform|"
    r"airport|hospital|clinic|shopping (centre|center|mall)|mall|supermarket|shop|store|office|"
    r"restaurant|cafe|café|canteen|school|classroom|university|library|museum|hotel|lobby|"
    r"car park|parking (lot|garage)|park|street|road|warehouse|factory|gym|church|kitchen|"
    r"bedroom|bathroom|living room|dining room|garage|garden|corridor|hallway|waiting (room|area)"
)
PLACE_GUESS = re.compile(
    r"\b(you('re| are| seem| appear)?|we|this|it|the (area|place|scene|setting|room|space|location))\b"
    r"[^.]{0,40}\b(is|are|be|seems?|appears?|looks?|could|might|may|probably|likely|'re|'s)\b"
    r"[^.]{0,25}\b(in|at|inside|like|of)?\s*(a|an|the|some (kind|sort|type) of)\s+"
    r"([a-z]+ ){0,2}(" + PLACE_NAMES + r")\b"
    r"|\b(looks?|seems?|appears?) (to be )?(like )?(a|an|the) ([a-z]+ ){0,2}(" + PLACE_NAMES + r")\b")
POSITION_WORDS = re.compile(r"\b(metres?|meters?|feet|foot|steps? (ahead|away|in front)|to your (left|right)|"
                            r"on your (left|right)|ahead of you|in front of you|behind you|beside you)\b")
WHERE_AM_I = ("where am i", "what place", "what kind of place", "what sort of place", "what is this place",
              "what's this place", "where are we", "what building", "what room")


PERSON_WORDS = re.compile(
    r"\b(person|people|man|men|woman|women|someone|somebody|child|children|kid|kids|boy|girl|guy|"
    r"lady|gentleman|he|she|they|face|figure|crowd|individual|pedestrian|passenger|staff)\b")
BACKGROUND_WORDS = {
    "pipe", "pipes", "pipework", "vent", "vents", "ceiling", "duct", "ducts", "ductwork", "poster",
    "posters", "painting", "paintings", "frame", "frames", "decoration", "decorations",
    "wallpaper", "shelf", "shelves", "shelving", "light", "lights", "lamp", "lamps", "fixture",
    "fixtures", "socket", "sockets", "outlet", "outlets", "switch", "switches", "plant", "plants",
    "curtain", "curtains", "blinds", "tiles", "pattern", "texture", "wire", "wires", "wiring",
    "conduit", "beam", "beams", "panel", "panels", "artwork",
}
IN_THE_WAY = re.compile(
    r"\b(in your way|in front of you|ahead|on the floor|on the ground|floor|ground|underfoot|"
    r"head height|hanging|low|blocking|path|walk into|trip|step|stairs|door|exit|sign says)\b")


def is_background_detail(sentence, question):
    """True for a sentence only about background things (pipes, vents, posters...) that aren't
    in their way, unless they asked about them or it also mentions a person."""
    n = normalise(sentence)
    words = set(re.findall(r"[a-z']+", n))
    background = words & BACKGROUND_WORDS
    if not background or background & set(re.findall(r"[a-z']+", normalise(question))):
        return False
    return not IN_THE_WAY.search(n) and not PERSON_WORDS.search(n)


def is_place_guess(sentence, question):
    """True for a guess about what kind of place it is, when they didn't ask."""
    if any(p in normalise(question) for p in WHERE_AM_I):
        return False
    n = normalise(sentence)
    if POSITION_WORDS.search(n):
        return False          # it also says where something is, which may matter more than the guess
    return bool(PLACE_GUESS.search(n))


def is_describe_question(question):
    n = normalise(question)
    return bool(set(re.findall(r"[a-z']+", n)) & DESCRIBE_WORDS) or any(p in n for p in DESCRIBE_PHRASES)


def is_path_question(question):
    return bool(set(re.findall(r"[a-z']+", normalise(question))) & PATH_WORDS)


def is_off_topic(question):
    words = set(re.findall(r"[a-z']+", normalise(question)))
    return not (words & TRAVEL_WORDS)


def needs_camera(question):
    n = normalise(question)
    if is_describe_question(question):
        return True
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
    people = []             # people the detector found in the picture
    ok = True

    def emit(sentence):
        sentence = clean_for_speech(sentence)
        if not sentence or stop.is_set():
            return
        print("Assistant:", sentence)
        audio = synth_audio(sentence)
        if stop.is_set():
            return
        out_q.put((sentence, audio))
        spoken.append(sentence)

    try:
        use_camera = needs_camera(question)

        if not use_camera:
            sentences = stream_sentences(build_messages(question), stop)
            first = next(sentences, None)
            if first is not None and "NEED_CAMERA" in first.upper():
                use_camera = True
                sentences.close()
            else:
                if first is not None and not is_needless_warning(first, question):
                    emit(first)
                for s in sentences:
                    if not is_needless_warning(s, question):
                        emit(s)
                # Off-topic question: make sure they hear a safety reminder, even if the model forgot
                answer = " ".join(spoken).lower()
                if (OFF_TOPIC_REMINDER and spoken and is_off_topic(question)
                        and not any(h in answer for h in REMINDER_HINTS)):
                    emit(SAFETY_REMINDERS[next(reminder_counter) % len(SAFETY_REMINDERS)])

        if use_camera:
            info["camera"] = True
            images, brightness, note, people = grab_frame(question)
            softened = False
            if not images:
                ok = False
                emit("I can't reach the camera. Please check that camera permission is switched on.")
            elif brightness < DARK_FRAME_LEVEL:
                ok = False
                emit("It's very dark, or the camera might be covered. Could you turn on a light or point the camera somewhere else?")
            else:
                for s in stream_sentences(build_messages(question, images, note), stop):
                    if "NEED_CAMERA" in s.upper():
                        continue                     # it already has the picture
                    if is_needless_warning(s, question):
                        print("(left out a needless warning:", s, ")")
                        continue
                    if is_place_guess(s, question):
                        print("(left out a guess about the place:", s, ")")
                        continue
                    if is_background_detail(s, question):
                        print("(left out an unimportant detail:", s, ")")
                        continue
                    if CLEAR_CLAIM.search(normalise(s)) and not re.search(
                            r"\b(except|but|apart|although|however|other than|besides|only)\b", normalise(s)):
                        # The camera can miss things: never state "it's clear" as a fact
                        if not softened:
                            emit(CLEAR_ANSWER)
                            softened = True
                        continue
                    emit(s)

        if info.get("camera") and not stop.is_set() and ok:
            said = normalise(" ".join(spoken))
            close = [p for p in people if p["close"]]
            if close and not PERSON_WORDS.search(said):
                # The detector is confident someone is right there, but the model left them out
                emit(f"There is a person close to the camera {close[0]['side']}.")

        if not spoken and not stop.is_set():
            # Everything the model said was a needless warning, so say something useful instead
            if info.get("camera"):
                emit("I don't see anything there that needs pointing out.")
            else:
                emit("I'm not sure about that one.")

        info["ok"] = ok
    except Exception as e:
        print("Model error:", e)
        emit("Sorry, I had a problem working that out. Could you try again?")
    finally:
        out_q.put(None)


def mac_memory_gb():
    try:
        return int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True,
                                  text=True).stdout.strip()) / 1024 ** 3
    except Exception:
        try:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024 ** 3
        except Exception:
            return 8.0


def installed_models():
    try:
        listing = ollama.list()
        models = listing.get("models", []) if isinstance(listing, dict) else getattr(listing, "models", [])
        names = set()
        for m in models:
            name = m.get("model") or m.get("name") if isinstance(m, dict) else getattr(m, "model", None)
            if name:
                names.add(name)
                names.add(name.replace(":latest", ""))
        return names
    except Exception as e:
        print("(could not list Ollama models:", e, ")")
        return set()


def choose_model():
    """Picks the most accurate installed vision model that fits in this Mac's memory."""
    if VISION_MODEL != "auto":
        return VISION_MODEL
    installed = installed_models()
    memory = mac_memory_gb()
    for name, needs_gb in VISION_MODEL_CHOICES:
        if name in installed and memory >= needs_gb:
            better = [n for n, gb in VISION_MODEL_CHOICES[:VISION_MODEL_CHOICES.index((name, needs_gb))]
                      if memory >= gb]
            print(f"(using vision model {name}; this Mac has {memory:.0f} GB of memory)")
            if better:
                print(f"(for more accurate descriptions, download {better[0]} with: ollama pull {better[0]})")
            return name
    print(f"(none of the listed models are installed; trying {VISION_MODEL_CHOICES[-1][0]})")
    return VISION_MODEL_CHOICES[-1][0]


def warm_up_model():
    """Loads the model into memory in the background so the first question isn't slow."""
    try:
        # Uses a small grey picture so the part of the model that looks at images is ready too,
        # and the same instructions and settings as real questions so nothing has to reload.
        grey = np.full((64, 64, 3), 128, dtype=np.uint8)
        options = dict(MODEL_OPTIONS, num_predict=1)
        ollama.chat(
            model=active_model,
            messages=[{"role": "system", "content": SYSTEM_PROMPT},
                      {"role": "user", "content": "Ready?", "images": [to_jpeg(grey)]}],
            keep_alive=-1,
            options=options,
        )
        print("(model ready)")
    except Exception as e:
        print("(Could not warm up the model:", e, ")")


# =========================== Helpers and main loop ===========================

def normalise(text):
    """Lower-case, no punctuation, single spaces. 'Bye-bye!' -> 'bye bye', 'Help, please.' -> 'help'."""
    t = text.lower().replace("-", " ").replace("’", "'")
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
    global pending_audio, camera, focus, speaker, last_answer

    clear_temp_audio()
    speaker = Speaker(voice_sample_rate())
    make_cue_sounds()
    focus = VoiceFocus()
    calibrate_noise()

    camera = Camera(CAMERA_INDEX)
    if not camera.running:
        print("(Could not open the camera. Check camera permission for this app.)")

    global whisper_model, active_model
    whisper = whisper_model = load_whisper()
    active_model = choose_model()
    load_voice()
    threading.Thread(target=warm_up_model, daemon=True).start()

    speak(GREETING)

    silent_rounds = 0

    while True:
        discard_unused_early()
        interrupted = False
        if pending_audio is not None:
            audio = pending_audio          # the user interrupted, so use what they said
            pending_audio = None
            interrupted = True
        else:
            cue("your_turn")               # two notes going up: "you can talk now"
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
        if question is None:
            print("(that was only background noise, listening again)")
            continue
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
        cue("got_it")                      # one short high note: "got it, thinking"
        t0 = time.time()
        early = take_early_answer(question)
        if early:
            # Already started on this answer during the pause at the end of the question
            out_q, stop, info = early["out_q"], early["stop"], early["info"]
            print(f"Thinking... (started {t0 - early['started']:.1f}s early)")
        else:
            print("Thinking...")
            out_q = queue.Queue()
            stop = threading.Event()
            info = {}
            threading.Thread(target=produce, args=(question, out_q, stop, info), daemon=True).start()

        def answer_pieces():
            """Hands each finished sentence to the speaker the moment it is ready."""
            first = True
            while True:
                try:
                    item = out_q.get(timeout=90)
                except queue.Empty:
                    print("(no answer in time)")
                    stop.set()
                    return
                if item is None:
                    return
                if first:
                    first = False
                    route = "camera" if info.get("camera") else "no camera"
                    print(f"(first words after {time.time() - t0:.1f}s, {route})")
                    yield "", CUE_AUDIO.get("my_turn")     # two notes going down: "I'm about to speak"
                yield item

        spoken, captured = speak_turn(answer_pieces())
        if captured is not None:
            stop.set()                     # the user interrupted, so stop working on this answer
            pending_audio = captured

        if spoken:
            last_answer = " ".join(spoken)
            if info.get("ok", True):
                remember(question, last_answer)
        print(f"(answer finished after {time.time() - t0:.1f}s)")
        speaker.report()
        time.sleep(0.1)

    if camera:
        camera.close()
    if speaker:
        speaker.close()
    print("Bye.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nBye.")