import { describe, expect, it } from 'vitest';
import { REPLACE_CONFIRMATION } from '../lib/sync/link';
import { SHARED_HISTORY_DAYS, confirmSharedDestructive, confirmSharedReplace, guardWrite, type Dialogs } from '../lib/sync/guards';

function dialogs(answers: { confirm?: boolean; prompt?: string | null } = {}) {
  const log = { alerts: [] as string[], confirms: [] as string[], prompts: [] as string[] };
  const d: Dialogs = {
    alert: (m) => void log.alerts.push(m),
    confirm: (m) => {
      log.confirms.push(m);
      return answers.confirm ?? false;
    },
    prompt: (m) => {
      log.prompts.push(m);
      return answers.prompt ?? null;
    },
  };
  return { d, log };
}

const LOCAL = { enabled: false, role: null } as const;
const shared = (role: 'admin' | 'editor' | 'viewer') => ({ enabled: true, role }) as const;

describe('local-only mode is untouched', () => {
  it('every guard passes through without asking anything', () => {
    const { d, log } = dialogs();
    expect(guardWrite('en', LOCAL, d)).toBe(true);
    expect(confirmSharedReplace('en', LOCAL, d)).toBe(true);
    expect(confirmSharedDestructive('en', LOCAL, d, 'shared.confirm.resetProject')).toBe(true);
    expect(log).toEqual({ alerts: [], confirms: [], prompts: [] });
  });
});

describe('guardWrite', () => {
  it('lets editors and admins through; stops read-only people with an explanation', () => {
    const ok = dialogs();
    expect(guardWrite('en', shared('editor'), ok.d)).toBe(true);
    expect(guardWrite('en', shared('admin'), ok.d)).toBe(true);
    const blocked = dialogs();
    expect(guardWrite('en', shared('viewer'), blocked.d)).toBe(false);
    expect(blocked.log.alerts).toHaveLength(1);
  });
});

describe('confirmSharedReplace (restoring a whole backup over the shared workspace)', () => {
  it('needs an administrator AND the exact typed word', () => {
    const typedRight = dialogs({ prompt: REPLACE_CONFIRMATION });
    expect(confirmSharedReplace('en', shared('admin'), typedRight.d)).toBe(true);
    expect(typedRight.log.prompts[0]).toContain(REPLACE_CONFIRMATION);
    expect(typedRight.log.prompts[0]).toContain(String(SHARED_HISTORY_DAYS));

    for (const wrong of ['replace', 'REPLACE ', '', null]) {
      const { d } = dialogs({ prompt: wrong });
      expect(confirmSharedReplace('en', shared('admin'), d)).toBe(false);
    }
  });

  it('editors and viewers are refused before any prompt, with the right explanation', () => {
    const editor = dialogs({ prompt: REPLACE_CONFIRMATION });
    expect(confirmSharedReplace('en', shared('editor'), editor.d)).toBe(false);
    expect(editor.log.prompts).toEqual([]);
    expect(editor.log.alerts).toHaveLength(1);

    const viewer = dialogs({ prompt: REPLACE_CONFIRMATION });
    expect(confirmSharedReplace('en', shared('viewer'), viewer.d)).toBe(false);
    expect(viewer.log.prompts).toEqual([]);
  });
});

describe('confirmSharedDestructive (reset / delete: destructive for everyone)', () => {
  it('asks once more and honours the answer', () => {
    const yes = dialogs({ confirm: true });
    expect(confirmSharedDestructive('en', shared('editor'), yes.d, 'shared.confirm.resetProject')).toBe(true);
    expect(yes.log.confirms[0]).toMatch(/EVERYONE/);
    const no = dialogs({ confirm: false });
    expect(confirmSharedDestructive('ja', shared('editor'), no.d, 'shared.confirm.resetProject')).toBe(false);
  });

  it('never even asks a read-only person', () => {
    const { d, log } = dialogs({ confirm: true });
    expect(confirmSharedDestructive('en', shared('viewer'), d, 'shared.confirm.resetProject')).toBe(false);
    expect(log.confirms).toEqual([]);
    expect(log.alerts).toHaveLength(1);
  });
});
