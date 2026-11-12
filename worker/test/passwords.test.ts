import { describe, expect, it } from 'vitest';
import { hashPassword, MIN_PASSWORD_LENGTH, randomToken, validatePasswordPolicy, verifyPassword } from '../src/passwords';

describe('password hashing (PBKDF2-SHA256, Workers-native WebCrypto)', () => {
  it('hashes and verifies a password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('produces a different hash for the same password (random salt)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('never throws on a malformed stored hash (a corrupt row fails closed)', async () => {
    for (const bad of ['', 'plaintext', 'pbkdf2$', 'pbkdf2$abc$x$y', 'bcrypt$100000$AAAA$BBBB', 'pbkdf2$0$AAAA$BBBB', 'pbkdf2$999999999$AAAA$BBBB']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('stores the iteration count with the hash (so it can be raised later)', async () => {
    const stored = await hashPassword('pw');
    expect(stored.split('$')[1]).toMatch(/^\d+$/);
  });
});

describe('password policy', () => {
  it('requires the minimum length and nothing else', () => {
    expect(validatePasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('too_short');
    expect(validatePasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH))).toBe('ok');
    expect(validatePasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH + 50))).toBe('ok');
  });
});

describe('random tokens', () => {
  it('are URL-safe and unique', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
