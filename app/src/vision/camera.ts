// Camera and microphone in the browser: the live video, a sharp JPEG frame to
// send to the models, and push-to-talk recording. Frames leave the page only
// when the person has the camera open (principle 8), and only to the local
// service (or Gemini when they ask online).

/** Open the back camera (a laptop's webcam on a laptop). */
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

export function closeStream(stream: MediaStream | null) {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

/** Variance of a Laplacian on a small grey copy: higher = sharper (the PRD's blur check, no OpenCV needed). */
function sharpness(ctx: CanvasRenderingContext2D, w: number, h: number): { sharp: number; brightness: number } {
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    sum += g[i];
  }
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      n++;
      const d = lap - mean;
      mean += d / n;
      m2 += d * (lap - mean);
    }
  return { sharp: n ? m2 / n : 0, brightness: sum / (w * h) };
}

export interface Frame {
  /** Base64 JPEG, no data: prefix. */
  jpeg: string;
  sharp: number;
  brightness: number;
}

/** One JPEG frame from the video, at most `maxSide` px (gemma3 looks at 896). */
export function grabFrame(video: HTMLVideoElement, maxSide = 896, quality = 0.85): Frame | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const small = document.createElement('canvas');
  small.width = 160;
  small.height = Math.round((160 * canvas.height) / canvas.width);
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(canvas, 0, 0, small.width, small.height);
  const { sharp, brightness } = sharpness(sctx, small.width, small.height);
  return { jpeg: canvas.toDataURL('image/jpeg', quality).split(',')[1], sharp, brightness };
}

/**
 * The sharpest of a short burst (the PRD: "grab 3 to 5 frames, send only the sharpest").
 * `maxSide` 1920 keeps full HD for Abdullah's assistant, which zooms into the centre to read signs.
 */
export async function sharpestFrame(video: HTMLVideoElement, count = 4, gapMs = 120, maxSide = 896): Promise<Frame | null> {
  let best: Frame | null = null;
  for (let i = 0; i < count; i++) {
    const f = grabFrame(video, maxSide);
    if (f && (!best || f.sharp > best.sharp)) best = f;
    if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return best;
}

/** Push-to-talk: start() then stop() → base64 audio (webm/opus), for Whisper in the local service. */
export function createRecorder() {
  let rec: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      chunks = [];
      rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start();
    },
    stop(): Promise<string | null> {
      return new Promise((resolve) => {
        if (!rec) return resolve(null);
        rec.onstop = async () => {
          closeStream(stream);
          const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' });
          rec = null;
          if (blob.size < 2000) return resolve(null);
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          resolve(btoa(bin));
        };
        rec.stop();
      });
    },
    get recording() {
      return rec?.state === 'recording';
    },
  };
}

/** Play Piper's WAV (base64). Resolves when it ends. */
export function playWav(b64: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(`data:audio/wav;base64,${b64}`);
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    void audio.play().catch(() => resolve());
  });
}
