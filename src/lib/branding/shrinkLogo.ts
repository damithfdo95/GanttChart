import { LOGO_LIMITS, LOGO_MIME_TYPES } from '../../../shared/branding';

export type LogoError = 'type' | 'unreadable' | 'tooLarge';

/** The largest picture file we are willing to even open (before it is shrunk). */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(blob);
  });

/**
 * Shrink a picked picture to at most 512 pixels on its longest side and encode it (WebP when the browser can, else PNG) under the stored size
 * limit, keeping the aspect ratio and any transparency. The server checks the result again; this only makes the upload small and valid.
 */
export async function shrinkLogo(file: File): Promise<{ mime: string; data: string }> {
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type)) throw Object.assign(new Error('type'), { code: 'type' satisfies LogoError });
  if (file.size > MAX_SOURCE_BYTES) throw Object.assign(new Error('large'), { code: 'tooLarge' satisfies LogoError });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw Object.assign(new Error('unreadable'), { code: 'unreadable' satisfies LogoError });
  }
  const scale = Math.min(1, LOGO_LIMITS.maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw Object.assign(new Error('unreadable'), { code: 'unreadable' satisfies LogoError });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const encode = (mime: string, quality?: number): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  for (const quality of [0.9, 0.8, 0.65, 0.5]) {
    const webp = await encode('image/webp', quality);
    if (webp !== null && webp.type === 'image/webp' && webp.size <= LOGO_LIMITS.maxBytes) return { mime: 'image/webp', data: await toBase64(webp) };
  }
  const png = await encode('image/png');
  if (png !== null && png.size <= LOGO_LIMITS.maxBytes) return { mime: 'image/png', data: await toBase64(png) };
  throw Object.assign(new Error('large'), { code: 'tooLarge' satisfies LogoError });
}
