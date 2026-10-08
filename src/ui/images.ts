// Image preparation for attachments. Every byte sent spends pad, so images
// are downscaled and re-encoded in the browser, offered at a few sizes with
// their exact cost. Re-encoding through a canvas also drops all metadata:
// EXIF location, camera model, timestamps and embedded thumbnails.

import type { ImageMime } from '../crypto/otp.ts';

export interface ImageOption {
  label: string;
  width: number;
  height: number;
  mime: ImageMime;
  data: Uint8Array;
}

const PRESETS = [
  { label: 'Small', maxSide: 640 },
  { label: 'Medium', maxSide: 1280 },
  { label: 'Large', maxSide: 2048 },
];
const WEBP_QUALITY = 0.72;
const JPEG_QUALITY = 0.78;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** Decodes an image file and encodes it at each preset size (smallest first). */
export async function prepareImage(file: Blob): Promise<ImageOption[]> {
  if (file.size > MAX_INPUT_BYTES) throw new Error('That image is over 50 MB.');
  let source: ImageBitmap;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This browser can’t open that image. Try a JPEG, PNG or WebP.');
  }
  try {
    const options: ImageOption[] = [];
    for (const preset of PRESETS) {
      const scale = Math.min(1, preset.maxSide / Math.max(source.width, source.height));
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      // A small original makes the bigger presets identical; offer it once.
      if (options.some((o) => o.width === width && o.height === height)) continue;
      options.push({ label: preset.label, width, height, ...(await encode(source, width, height)) });
    }
    if (options.length === 1) options[0].label = 'Full size';
    return options;
  } finally {
    source.close();
  }
}

async function encode(source: ImageBitmap, width: number, height: number): Promise<{ mime: ImageMime; data: Uint8Array }> {
  // Resize with the browser's high-quality scaler first where supported;
  // drawImage then just copies (or scales, if the option was ignored).
  const resized = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }).catch(() => source);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(resized, 0, 0, width, height);
  if (resized !== source) resized.close();

  let blob = await toBlob(canvas, 'image/webp', WEBP_QUALITY);
  let mime: ImageMime = 'image/webp';
  // Browsers that can't encode WebP silently return PNG, which would be huge.
  if (blob?.type !== 'image/webp') {
    // JPEG has no transparency: flatten onto white rather than black.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    blob = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    mime = 'image/jpeg';
  }
  if (!blob) throw new Error('Couldn’t encode the image.');
  canvas.width = canvas.height = 0; // release the bitmap memory promptly
  return { mime, data: new Uint8Array(await blob.arrayBuffer()) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
