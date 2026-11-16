/*
 * Histeon behaviours (docs/spec/interactions.md): tabs, toggles (mobile menu, disclosure) and reveal on scroll.
 * Progressive: without this script every panel, menu and element is visible and usable. It only reads
 * data-xb-* attributes and ARIA; it never runs anything from the page.
 */
(() => {
  document.documentElement.classList.add('xb-js');

  // Tabs: [data-xb-tabs] holding [role=tab][aria-controls] buttons; arrows, Home and End move between them.
  for (const root of document.querySelectorAll('[data-xb-tabs]')) {
    const tabs = [...root.querySelectorAll('[role="tab"]')].filter((t) => t.closest('[data-xb-tabs]') === root);
    if (!tabs.length) continue;
    const panel = (t) => document.getElementById(t.getAttribute('aria-controls') || '');
    const select = (tab, focus) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const p = panel(t);
        if (p) p.hidden = !on;
      }
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const last = tabs.length - 1;
        const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: last }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length], true);
      });
    });
    select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0], false);
  }

  // Toggles: button[data-xb-toggle][aria-controls] opens and closes its target (data-open); Esc closes it.
  for (const button of document.querySelectorAll('button[data-xb-toggle][aria-controls]')) {
    const target = document.getElementById(button.getAttribute('aria-controls') || '');
    if (!target) continue;
    const set = (open) => {
      button.setAttribute('aria-expanded', String(open));
      target.toggleAttribute('data-open', open);
    };
    set(button.getAttribute('aria-expanded') === 'true');
    button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && button.getAttribute('aria-expanded') === 'true') {
        // Handled: whatever is around the page (a dialog, the builder's preview) leaves this Esc alone.
        e.preventDefault();
        set(false);
        button.focus();
      }
    });
  }

  // Embeds (videos, maps): before the player goes there, a cancelable «xb:incorpora» event on the link lets a consent
  // plugin hold it (Consenso Bridge waits for the consent of Complianz) and call detail.carica() later.
  const embed = (link, tipo, fornitore, src, carica) => {
    const once = () => { if (link.isConnected) carica(); };
    const event = new CustomEvent('xb:incorpora', { bubbles: true, cancelable: true, detail: { tipo, fornitore, src, carica: once } });
    if (link.dispatchEvent(event)) once();
  };

  // Videos (E9): [data-xb-video] holds a link to the video with a poster served by the site. Nothing is asked of
  // YouTube or Vimeo until the click puts the player there, from youtube-nocookie.com or Vimeo with dnt=1.
  for (const box of document.querySelectorAll('[data-xb-video]')) {
    const src = box.getAttribute('data-xb-video') || '';
    const link = box.querySelector('a[href]');
    if (!link || !/^https:\/\/(www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d{1,12})$/.test(src)) continue;
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      embed(link, 'video', src.includes('vimeo') ? 'Vimeo' : 'YouTube', src, () => {
        const frame = document.createElement('iframe');
        frame.src = src + (src.includes('vimeo') ? '?autoplay=1&dnt=1' : '?autoplay=1&rel=0');
        frame.title = link.getAttribute('aria-label') || link.textContent || 'Video';
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.allowFullscreen = true;
        frame.className = 'xb-video__frame';
        link.replaceWith(frame);
        frame.focus();
      });
    });
  }

  // The «Video» block of an article (list item 84 of Histeon Publish): a link to YouTube or Vimeo, kept as a link in the
  // content; the click puts the player there, from youtube-nocookie.com or Vimeo with dnt=1. Any other address, or an
  // id that is not one, stays a link.
  for (const link of document.querySelectorAll('a.xb-art-video[href]')) {
    let url;
    try { url = new URL(link.href); } catch { continue; }
    const host = url.hostname.replace(/^(www|m)\./, '');
    const youtube = url.protocol === 'https:' && host === 'youtube.com' && url.pathname === '/watch' ? url.searchParams.get('v') : url.protocol === 'https:' && host === 'youtu.be' ? url.pathname.slice(1) : null;
    const vimeo = url.protocol === 'https:' && host === 'vimeo.com' ? url.pathname.slice(1) : null;
    const src = youtube && /^[\w-]{6,20}$/.test(youtube) ? 'https://www.youtube-nocookie.com/embed/' + youtube + '?autoplay=1&rel=0' : vimeo && /^\d{1,12}$/.test(vimeo) ? 'https://player.vimeo.com/video/' + vimeo + '?autoplay=1&dnt=1' : null;
    if (!src) continue;
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      embed(link, 'video', src.includes('vimeo') ? 'Vimeo' : 'YouTube', src, () => {
        const frame = document.createElement('iframe');
        frame.src = src;
        frame.title = (link.textContent || 'Video').trim();
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.allowFullscreen = true;
        frame.className = 'xb-art-video-frame';
        frame.style.cssText = 'display:block;width:100%;aspect-ratio:16/9;border:0';
        link.replaceWith(frame);
        frame.focus();
      });
    });
  }

  // Maps (E11): [data-xb-map] holds a link to the map; OpenStreetMap or Google Maps get a request only when the
  // click puts the map there. Only their embeddable addresses are accepted.
  for (const box of document.querySelectorAll('[data-xb-map]')) {
    const src = box.getAttribute('data-xb-map') || '';
    const link = box.querySelector('a[href]');
    if (!link || !/^https:\/\/(www\.openstreetmap\.org\/export\/embed\.html\?[\w.%&=-]+|www\.google\.com\/maps\/embed\?pb=[\w!.*:%-]+|maps\.google\.com\/maps\?[\w.%&=+-]+)$/.test(src)) continue;
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      embed(link, 'mappa', src.includes('openstreetmap') ? 'OpenStreetMap' : 'Google Maps', src, () => {
        const frame = document.createElement('iframe');
        frame.src = src;
        frame.title = (link.textContent || 'Mappa').trim();
        frame.className = 'xb-map__frame';
        frame.referrerPolicy = 'no-referrer-when-downgrade';
        link.replaceWith(frame);
        frame.focus();
      });
    });
  }

  // Reveal on scroll: [data-xb-reveal] gets .is-visible when it enters the screen (at once with reduced motion).
  const reveal = [...document.querySelectorAll('[data-xb-reveal]')];
  const show = (el) => el.classList.add('is-visible');
  if (!reveal.length) return;
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reveal.forEach(show);
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        show(e.target);
        seen.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );
  reveal.forEach((el) => seen.observe(el));
})();
