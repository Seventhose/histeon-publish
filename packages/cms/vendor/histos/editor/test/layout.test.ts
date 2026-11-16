import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, movePanel, normalize, resize, shareBetween, shiftPanel, toggleCollapsed } from '../src/lib/layout.ts';

describe('panel layout', () => {
  it('reads back anything as a valid layout', () => {
    expect(normalize(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalize('x')).toEqual(DEFAULT_LAYOUT);
    const odd = normalize({ areas: { left: ['css', 'css', 'evil', '__proto__'], right: ['structure'], bottom: 'no' }, collapsed: ['js', 7], sizes: { left: 9999, right: -5, bottom: 20 } });
    expect(odd.areas).toEqual({ left: ['css'], right: ['structure', 'properties', 'recipes'], bottom: ['html', 'js'] });
    // A panel the stored layout does not know yet (the recipes) arrives collapsed, as in the default.
    expect(odd.collapsed).toEqual(['js', 'recipes']);
    expect(odd.sizes).toEqual({ left: 640, right: 220, bottom: 0 });
  });

  it('moves and reorders panels across areas', () => {
    let l = movePanel(DEFAULT_LAYOUT, 'structure', 'left', 0);
    expect(l.areas).toEqual({ left: ['structure'], right: ['properties', 'recipes'], bottom: ['html', 'css', 'js'] });
    l = movePanel(l, 'js', 'bottom', 0);
    expect(l.areas.bottom).toEqual(['js', 'html', 'css']);
    l = shiftPanel(l, 'js', 1);
    expect(l.areas.bottom).toEqual(['html', 'js', 'css']);
    l = shiftPanel(l, 'html', -1);
    expect(l.areas.bottom).toEqual(['html', 'js', 'css']);
    l = movePanel(l, 'css', 'right', 99);
    expect(l.areas.right).toEqual(['properties', 'recipes', 'css']);
    expect(DEFAULT_LAYOUT.areas.left).toEqual([]);
  });

  it('collapses, resizes and reopens a hidden bottom area when a panel lands there', () => {
    let l = toggleCollapsed(DEFAULT_LAYOUT, 'properties');
    expect(l.collapsed).toEqual(['recipes', 'properties']);
    expect(toggleCollapsed(l, 'properties').collapsed).toEqual(['recipes']);
    l = resize(l, 'bottom', 0);
    expect(l.sizes.bottom).toBe(0);
    expect(movePanel(l, 'structure', 'bottom', 0).sizes.bottom).toBe(300);
  });
});

describe('shares between panels and the maximized panel (L4)', () => {
  it('keeps valid weights and a known maximized panel, drops the rest', () => {
    const layout = normalize({ weights: { html: 2, css: 'x', js: 99, nope: 1 }, maximized: 'css' });
    expect(layout.weights).toEqual({ html: 2, js: 8 });
    expect(layout.maximized).toBe('css');
    expect(normalize({ maximized: 'nope' }).maximized).toBeNull();
    expect(normalize(null).weights).toEqual({});
  });

  it('splits two panels in the proportion of the separator, never below the floor', () => {
    const base = normalize(null);
    const wide = shareBetween(base, 'html', 'css', 300, 400);
    expect(wide.weights).toEqual({ html: 1.5, css: 0.5 });
    const squeezed = shareBetween(base, 'html', 'css', 5, 400);
    expect(squeezed.weights.html).toBeCloseTo(0.4, 5);
    expect(squeezed.weights.css).toBeCloseTo(1.6, 5);
    // The other panels keep their share.
    expect(shareBetween({ ...base, weights: { js: 3 } }, 'html', 'css', 200, 400).weights.js).toBe(3);
  });
});
