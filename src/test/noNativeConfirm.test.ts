import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true });

/** Lines that are only comment text (// ..., /* ..., * ...) are ignored; code lines are never altered. */
const codeLines = (text: string): string[] => text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));

describe('confirmation dialogs', () => {
  it('scans the screens (guard against an empty glob)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it('no screen uses the native window.confirm (all go through the accessible ConfirmDialog)', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => codeLines(text).some((line) => /\bwindow\.confirm\(/.test(line)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
