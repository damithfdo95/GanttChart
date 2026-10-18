/** Local file download via Blob + object URL — nothing ever leaves the machine. */

/**
 * File-name timestamp in LOCAL time, "YYYY-MM-DD-HHmm". (toISOString is UTC, which put the wrong
 * day in the name for anyone east or west of Greenwich around midnight.)
 */
export function fileStamp(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export function downloadTextFile(filename: string, mime: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function downloadBinaryFile(filename: string, mime: string, bytes: Uint8Array): void {
  downloadBlob(
    filename,
    new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mime }),
  );
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Escape text for safe embedding in exported HTML (print-to-PDF). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
