<script lang="ts" module>
  // Histeon's own icons (24×24, 1.75 stroke, round joins), drawn for the builder: one family for the rail, the
  // toolbars and the panels, instead of assorted text glyphs.
  export const ICONS = {
    content: 'M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5 M10 16h5',
    templates: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M4 9h16 M10 9v11',
    styles: 'M9.5 4 7.5 20 M16.5 4l-2 16 M5 9h15 M4 15h15',
    queries: 'M5 6a7 3 0 1 0 14 0a7 3 0 1 0-14 0 M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
    facets: 'M4 5h16l-6 7.5V18l-4 2v-7.5z',
    fields: 'M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M4 10h16 M10 10v9',
    components: 'M12 3l7 7-7 7-7-7z M8.5 17.5 12 21l3.5-3.5',
    history: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4 M12 8v4l3 2',
    schema: 'M5 7h14 M5 17h14 M9 4.5v5 M15 14.5v5',
    commands: 'M9 9V7a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v10a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2z',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
    code: 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
    moon: 'M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z',
    sidebar: 'M4 5h16v14H4z M15 5v14 M17 9h1 M17 12h1',
    system: 'M3.5 5h17v11h-17z M9 20h6 M12 16v4',
    sun: 'M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0 M12 2.5v2 M12 19.5v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2.5 12h2 M19.5 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    plus: 'M12 5v14 M5 12h14',
    media: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18 M15 9h.01',
    library: 'M5 4h3v16H5z M10 4h3v16h-3z M15.5 4.5l2.9-.8 3.6 15.6-2.9.8z',
    chat: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M8 10h8 M8 13h5',
    palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8l-.4-.8c-.5-1 .2-2.2 1.3-2.2H16a5 5 0 0 0 5-5c0-4.5-4-8.2-9-8.2z M7.5 11.5h.01 M10 7.5h.01 M14.5 7.5h.01',
    check: 'M12 3l7.5 3v5.5c0 4.4-3.1 8.1-7.5 9.5-4.4-1.4-7.5-5.1-7.5-9.5V6z M8.5 12l2.5 2.5 4.5-5',
    file: 'M7 3h7l4 4v14H7z M14 3v4h4 M10.5 11.5 8.5 14l2 2.5 M14 11.5l2 2.5-2 2.5',
    loop: 'M17 2l3 3-3 3 M4 11V9a4 4 0 0 1 4-4h12 M7 22l-3-3 3-3 M20 13v2a4 4 0 0 1-4 4H4',
    external: 'M14 4h6v6 M20 4l-9 9 M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
    undo: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  } as const;
  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  let { name, size = 18 }: { name: IconName; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d={ICONS[name]} /></svg>
