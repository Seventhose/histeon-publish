import { describe, expect, it, vi } from 'vitest';

// The styles store asks the server again after a failure (like useFramework and useQueries in logic.ts):
// a panel opened after a network error must not stay without styles until the page is reloaded.
const getStyles = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  Api: class {
    getStyles = getStyles;
  },
}));

(globalThis as unknown as { window: unknown }).window = {
  xbInspector: { restUrl: '/wp-json/xb/v1/', nonce: 'n' },
  wp: { element: { createElement: () => null, useState: () => [0, () => {}], useEffect: (f: () => void) => f(), useRef: () => ({ current: null }), useMemo: (f: () => unknown) => f(), Fragment: 'f' } },
};

describe('styles in Gutenberg', () => {
  it('loads again after a failure', async () => {
    const { useStyles } = await import('../src/gutenberg/styles.ts');
    getStyles.mockRejectedValueOnce(new Error('rete')).mockResolvedValueOnce({ styles: [], revision: 'r1' });
    const settle = () => new Promise((done) => setTimeout(done, 0));
    useStyles();
    await settle();
    // The next panel finds the error, and its opening asks again.
    expect(useStyles().error).toBe('rete');
    expect(getStyles).toHaveBeenCalledTimes(2);
    await settle();
    expect(useStyles().data).toEqual({ styles: [], revision: 'r1' });
    expect(useStyles().error).toBe('');
    expect(getStyles).toHaveBeenCalledTimes(2);
  });
});
