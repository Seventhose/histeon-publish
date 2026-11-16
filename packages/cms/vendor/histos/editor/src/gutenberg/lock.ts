// «Histeon · Struttura», a panel of the document settings (lista della spesa 138): whoever builds locks the page's
// structure; then anyone else who edits it in the block editor changes only texts and pictures (the editor opens
// content-only for them, and the server refuses anything else: plugin/src/Security/StructureLock.php).
import { config } from './context.ts';
import { __, h, wp } from './wp.ts';

const META = 'xb_structure_locked';

function LockPanel() {
  const locked = wp.data.useSelect((select: any) => Boolean(select('core/editor').getEditedPostAttribute('meta')?.[META]), []);
  const { editPost } = wp.data.useDispatch('core/editor');
  return h(
    'div',
    null,
    h(wp.components.ToggleControl, {
      label: __('Struttura bloccata'),
      checked: locked,
      onChange: (next: boolean) => editPost({ meta: { [META]: next } }),
      help: locked
        ? __('Chi non costruisce con Histeon cambia qui solo testi e immagini: niente blocchi aggiunti, tolti o spostati.')
        : __('Accendilo per lasciare ai redattori solo testi e immagini di questa pagina.'),
      __nextHasNoMarginBottom: true,
    }),
  );
}

export function registerLock(): void {
  if (!config || config.client) return;
  const Panel = wp.editor?.PluginDocumentSettingPanel ?? wp.editPost?.PluginDocumentSettingPanel;
  if (!Panel || !wp.plugins?.registerPlugin) return;
  wp.plugins.registerPlugin('xb-structure-lock', { render: () => h(Panel, { name: 'xb-structure-lock', title: __('Histeon · Struttura') }, h(LockPanel)) });
}
