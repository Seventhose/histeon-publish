// WordPress's own globals in the block editor (React through wp.element): typed only as far as used here.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GutenbergBlock {
  clientId: string;
  name: string;
  attributes: Record<string, any>;
  innerBlocks: GutenbergBlock[];
}

export const wp = (window as unknown as { wp: any }).wp;
export const h = wp.element.createElement as (type: any, props?: any, ...children: any[]) => any;
export const { useState, useEffect, useRef, useMemo, Fragment } = wp.element as {
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
  useMemo: <T>(fn: () => T, deps: unknown[]) => T;
  Fragment: any;
};
// Same catalog as the builder (docs/spec/i18n.md), sent by EditorLaunch in window.xbInspector.
export { t as __ } from '../lib/i18n.ts';
