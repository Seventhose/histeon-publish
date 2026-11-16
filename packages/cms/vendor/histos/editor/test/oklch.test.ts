import { describe, expect, it } from 'vitest';
import { oklchToHex } from '../src/lib/oklch.ts';

describe('oklchToHex', () => {
  it('matches the server conversion (Color.php) for known colours', () => {
    // oklch(53.4% 0.125 247.7) is #2271b1 on the server (TramaTest round trip).
    expect(oklchToHex('oklch(53.4% 0.125 247.7)')).toBe('#2271b1');
    expect(oklchToHex('oklch(100% 0 0)')).toBe('#ffffff');
    expect(oklchToHex('oklch(0 0 0)')).toBe('#000000');
  });
  it('keeps hex, and falls back on black for anything unreadable', () => {
    expect(oklchToHex('#ABCDEF')).toBe('#abcdef');
    expect(oklchToHex('red')).toBe('#000000');
    expect(oklchToHex('')).toBe('#000000');
  });
});
