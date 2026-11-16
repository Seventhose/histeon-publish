// Histeon in the block editor's command palette (Ctrl+K, lista della spesa 140): the same keys as the builder's own
// palette, with Histeon's actions next to WordPress's. Registered through wp.commands when the editor has it.
import { config } from './context.ts';
import { saveStyles } from './styles.ts';
import { __, wp } from './wp.ts';

export interface HisteonCommand {
  name: string;
  label: string;
  callback: (close: () => void) => void;
}

/** The commands, for whoever builds; a client gets only the ones that change nothing. */
export function commands(): HisteonCommand[] {
  if (!config) return [];
  const go = (url: string) => (close: () => void) => {
    close();
    window.location.href = url;
  };
  const sidebar = (name: string) => (close: () => void) => {
    close();
    wp.data.dispatch('core/edit-post')?.openGeneralSidebar?.(name);
  };
  const list: HisteonCommand[] = [
    { name: 'xb/open-builder', label: __('Histeon: apri questa pagina nel builder'), callback: go(config.builderUrl) },
    { name: 'xb/history', label: __('Histeon: versioni di questa pagina'), callback: go(config.historyUrl) },
    { name: 'xb/releases', label: __('Histeon: release'), callback: go(config.releasesUrl) },
  ];
  if (!config.client) {
    list.push(
      { name: 'xb/library', label: __('Histeon: inserisci una sezione dalla libreria'), callback: sidebar('xb-library/xb-library') },
      {
        name: 'xb/save-styles',
        label: __('Histeon: salva gli stili in sviluppo'),
        callback: (close) => {
          close();
          void saveStyles();
        },
      },
    );
  }
  return list;
}

export function registerCommands(): void {
  const store = wp.data.dispatch('core/commands');
  if (!store?.registerCommand) return;
  for (const c of commands()) store.registerCommand({ name: c.name, label: c.label, callback: ({ close }: { close: () => void }) => c.callback(close) });
}
