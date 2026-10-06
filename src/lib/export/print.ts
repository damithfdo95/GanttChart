import { escapeHtml } from './download';

/**
 * Dependency-free "Export PDF": renders the report as a clean HTML document
 * and opens the browser print dialog (print → save as PDF). URLs stay
 * clickable in the printed document.
 */

function linkify(text: string): string {
  return text.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1">$1</a>');
}

export function textToHtml(text: string): string {
  return linkify(escapeHtml(text))
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .map((block) => `<p>${block.split('\n').join('<br>')}</p>`)
    .join('');
}

/** Returns false when the print window could not be opened (popup blocker). */
export function printHtml(title: string, bodyHtml: string): boolean {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (win === null) return false;
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<style>' +
      'body{font-family:"Segoe UI",system-ui,"Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif;' +
      'color:#1f2733;max-width:800px;margin:32px auto;line-height:1.6;}' +
      'h1{font-size:18px;border-bottom:2px solid #1a56db;padding-bottom:6px;}' +
      'p{white-space:normal;}' +
      'a{color:#1a56db;}' +
      'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #d7dee6;padding:6px 10px;text-align:left;}' +
      'th{background:#f4f6f8;}' +
      '</style></head><body>' +
      `<h1>${escapeHtml(title)}</h1>${bodyHtml}` +
      '<script>window.onload=function(){window.print();}<\/script>' +
      '</body></html>',
  );
  win.document.close();
  return true;
}
