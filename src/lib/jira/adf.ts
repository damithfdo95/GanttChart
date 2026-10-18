/**
 * ADF → plain text (JIRA import).
 *
 * JIRA Cloud describes issue text in Atlassian Document Format (ADF): a tree
 * of nodes where `content` arrays nest children and `text`/`hardBreak` nodes
 * carry the actual characters. JIRA Data Center returns plain strings
 * instead. `adfToPlainText` flattens an ADF tree to readable line-based text:
 *
 *  - text / hardBreak nodes produce characters (hard breaks become "\n");
 *  - every block-level child of the document is joined with "\n";
 *  - tables put cell text on one line (cells joined by a space) and rows on
 *    separate lines;
 *  - inline cards, mentions, emoji, media and rules contribute no text.
 *
 * `cleanPlainText` trims the result and collapses blank runs to one blank
 * line, so the output is tidy even when the source is messy. Both functions
 * are exported for unit tests.
 */

interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

function asNode(v: unknown): AdfNode | null {
  return typeof v === 'object' && v !== null ? (v as AdfNode) : null;
}

function childrenOf(v: unknown): unknown[] {
  const node = asNode(v);
  return Array.isArray(node?.content) ? (node.content as unknown[]) : [];
}

function typeOf(v: unknown): string {
  const node = asNode(v);
  return typeof node?.type === 'string' ? node.type : '';
}

/** Leaf/inline flattening — produces no newlines except for explicit hard breaks. */
function inlineText(v: unknown): string {
  const node = asNode(v);
  if (node === null) return typeof v === 'string' ? v : '';
  const type = typeOf(v);
  if (type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (type === 'hardBreak') return '\n';
  // Mentions/emoji/media/rule carry no characters worth importing.
  if (type === 'mention' || type === 'emoji' || type === 'media' || type === 'mediaSingle' || type === 'rule') return '';
  return childrenOf(v).map(inlineText).join('');
}

/** One block node flattened to lines of plain text. */
function blockText(v: unknown): string {
  const type = typeOf(v);
  if (type === 'table') {
    // One line per row; cells inside a row are joined by a space so wide
    // cell text does not explode into columns of blank lines.
    return childrenOf(v)
      .map((row) => childrenOf(row).map((cell) => inlineText(cell)).join(' '))
      .join('\n');
  }
  if (type === 'bulletList' || type === 'orderedList' || type === 'taskList' || type === 'decisionList') {
    return childrenOf(v).map(blockText).join('\n');
  }
  if (type === 'blockquote' || type === 'panel' || type === 'listItem' || type === 'taskItem' || type === 'decisionItem') {
    return childrenOf(v).map(inlineText).join('\n');
  }
  // paragraphs, headings, code blocks and anything unknown: inline text.
  return inlineText(v);
}

/**
 * Trim whitespace and collapse runs of blank lines to a single blank line
 * (also strips spaces that only pad line starts/ends).
 */
export function cleanPlainText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Flatten an ADF description node (or a plain string) to plain text. The
 * top-level content array is treated as a sequence of blocks joined by "\n".
 */
export function adfToPlainText(node: unknown): string {
  if (typeof node === 'string') return node;
  const n = asNode(node);
  if (n === null) return '';
  const type = typeof n.type === 'string' ? n.type : '';
  if (type === 'text') return typeof n.text === 'string' ? n.text : '';
  const blocks = Array.isArray(n.content) ? (n.content as unknown[]) : [];
  if (blocks.length === 0) return '';
  return blocks.map(blockText).join('\n');
}