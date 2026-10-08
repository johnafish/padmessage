// Camera capture for pad generation. Frames are read at the camera's native
// resolution (scaling would average the noise away), conditioned by
// crypto/entropy.ts, and discarded. Nothing is stored or sent.

import { conditionFrame } from '../crypto/entropy.ts';

export function cameraSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(video: HTMLVideoElement, stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

export interface CameraProgress {
  collected: number;
  target: number;
  bytesPerSecond: number;
  /** none: no usable noise lately (covered lens, frozen or clipped image). */
  quality: 'good' | 'low' | 'none';
}

/** Resolves on the next decoded frame, or at once if cancelled (frames stop while a tab is hidden). */
function nextFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done);
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(done);
    else setTimeout(done, 1000 / 30);
  });
}

/** Collects `target` bytes of conditioned camera noise from a playing video. */
export async function collectCameraNoise(
  video: HTMLVideoElement,
  target: number,
  onProgress: (p: CameraProgress) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })!;
  const out = new Uint8Array(target);
  let filled = 0;
  let prev: Uint8ClampedArray | null = null;
  let frameNo = 0;
  const started = performance.now();
  let lastUseful = started;
  let lastRate = 0; // credited bits per sample, latest frame

  try {
    while (filled < target) {
      if (signal.aborted) throw new DOMException('Camera collection cancelled', 'AbortError');
      await nextFrame(video, signal);
      if (signal.aborted) throw new DOMException('Camera collection cancelled', 'AbortError');
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) continue;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        prev = null; // resolution changed: differences would be meaningless
      }
      ctx.drawImage(video, 0, 0, w, h);
      const cur = ctx.getImageData(0, 0, w, h).data;
      if (prev) {
        const y = await conditionFrame(cur, prev, frameNo++);
        const take = Math.min(y.bytes.length, target - filled);
        out.set(y.bytes.subarray(0, take), filled);
        filled += take;
        y.bytes.fill(0);
        lastRate = y.samples ? y.credited / y.samples : 0;
        if (take > 0) lastUseful = performance.now();
        prev.fill(0);
      }
      prev = cur;
      const now = performance.now();
      onProgress({
        collected: filled,
        target,
        bytesPerSecond: filled / Math.max(0.001, (now - started) / 1000),
        quality: now - lastUseful > 3000 ? 'none' : lastRate >= 0.2 ? 'good' : 'low',
      });
    }
    return out;
  } catch (err) {
    out.fill(0);
    throw err;
  } finally {
    prev?.fill(0);
  }
}
