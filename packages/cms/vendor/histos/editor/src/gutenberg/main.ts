// Entry of the Gutenberg inspector bundle (plugin/assets/gutenberg/inspector.js, loaded by EditorLaunch).
import { config, register } from './inspector.ts';
import { registerDock } from './dock.ts';
import { registerLibrary } from './library.ts';
import { registerLock } from './lock.ts';
import { registerCommands } from './commands.ts';
import { loadPageStyles } from './pageStyles.ts';

const style = document.createElement('style');
style.textContent = `
.xb-insp .xb-insp-body{display:grid;gap:10px;padding-top:12px}
.xb-insp-chips{display:flex;flex-wrap:wrap;gap:6px}
.xb-insp-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border:1px solid #ddd;border-radius:999px;font:12px ui-monospace,Menlo,Consolas,monospace;background:#f6f7f7}
.xb-insp-chip.is-dynamic{padding-right:8px;color:#50575e;font-style:italic}
.xb-insp-chip button{border:0;background:none;cursor:pointer;font-size:14px;line-height:1;color:#50575e;padding:0 4px}
.xb-insp-pill{font:12px ui-monospace,Menlo,Consolas,monospace;padding:3px 8px;border-radius:999px;border:1px solid #ddd;background:#fff;cursor:pointer}
.xb-insp-pill.is-active{background:#3858e9;border-color:#3858e9;color:#fff}
.xb-insp-row{display:flex;gap:6px;align-items:center}
.xb-insp-row input,.xb-insp-field input{flex:1;min-width:0;font:12px ui-monospace,Menlo,Consolas,monospace;padding:4px 8px;border:1px solid #949494;border-radius:2px}
.xb-insp-field{display:grid;gap:4px;font-size:11px;text-transform:uppercase;color:#50575e}
.xb-insp-note{margin:0;color:#50575e;font-size:12px}
.xb-insp-label{margin:4px 0 0;font:11px ui-monospace,Menlo,Consolas,monospace;color:#50575e}
.xb-insp-error{margin:0;color:#b32d2e;font-size:12px}
.xb-insp-code{border:1px solid #ddd;border-radius:2px;resize:vertical;overflow:hidden}
.xb-look-context{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.xb-look-groups{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #e0e0e0;padding-bottom:6px}
.xb-look-group{position:relative;border:0;background:none;cursor:pointer;font:500 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:4px 8px;border-radius:2px;color:#1e1e1e}
.xb-look-group:hover{background:#f0f0f0}
.xb-look-group.is-active{background:#1e1e1e;color:#fff}
.xb-look-dot{display:inline-block;width:6px;height:6px;margin-left:4px;border-radius:50%;background:#e2725b;vertical-align:middle}
.xb-look-body{display:grid;gap:12px}
.xb-look-control{display:grid;gap:6px}
.xb-look-label{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:500;color:#1e1e1e}
.xb-look-label code{font:11px ui-monospace,Menlo,Consolas,monospace;color:#757575;background:none;padding:0}
.xb-look-options{display:flex;flex-wrap:wrap;gap:4px}
.xb-insp-pill.has-swatch{display:inline-flex;align-items:center;gap:5px}
.xb-look-swatch{width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}
.xb-look-change{margin:0;padding:6px 8px;border-left:3px solid #e2725b;background:#fdf3f0;font-size:12px;color:#1e1e1e}
.xb-logic{display:grid;gap:10px}
.xb-logic-sentence{margin:0;padding:8px;border-radius:2px;background:#f0f6fc;font-size:13px;color:#1e1e1e}
.xb-logic-compose{display:grid;gap:8px}
.xb-library{display:grid;gap:10px}
.xb-library-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.xb-library-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;border:1px solid #e0e0e0;border-radius:2px}
.xb-library-name{display:grid;font-size:13px;font-weight:500}
.xb-library-name small{font-weight:400;color:#757575}
.xb-insp-code.is-fill{height:100%;border:0;border-radius:0;resize:none}
.xb-dock-host{flex:none;min-height:0}
.xb-dock{position:relative;display:grid;grid-template-rows:auto minmax(0,1fr);background:#f6f7f7;border-top:1px solid #dcdcde;font-size:13px;color:#1e1e1e}
.xb-dock.is-closed{grid-template-rows:auto}
.xb-dock-resize{position:absolute;left:0;right:0;top:-4px;height:8px;cursor:row-resize;z-index:2;touch-action:none}
.xb-dock-resize:hover{background:rgba(56,88,233,.5)}
.xb-dock-bar{display:flex;align-items:center;gap:10px;height:32px;padding:0 8px;border-bottom:1px solid #dcdcde;background:#fff}
.xb-dock.is-closed .xb-dock-bar{border-bottom:0}
.xb-dock-bar button{border:0;background:none;cursor:pointer;font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e1e1e;padding:4px 6px;border-radius:2px}
.xb-dock-bar button:hover{background:#f0f0f0}
.xb-dock-what{font:12px ui-monospace,Menlo,Consolas,monospace;color:#50575e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xb-dock-grow{flex:1}
.xb-dock-link{font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e1e1e;text-decoration:none;padding:4px 6px;border-radius:2px}
.xb-dock-link:hover{background:#f0f0f0;color:#1e1e1e}
.xb-doc-status{display:flex;align-items:center;gap:6px;margin:0 0 8px}
.xb-doc-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500}
.xb-doc-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.xb-doc-pill.is-live{background:#e6f4ea;color:#00873e}
.xb-doc-pill.is-dev{background:#fdf1e0;color:#9a5b00}
.xb-doc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.xb-dock-cols{display:flex;min-height:0}
.xb-dock-col{flex:1 1 0;min-width:0;margin:0;padding:0;display:grid;grid-template-rows:auto minmax(0,1fr);border-right:1px solid #dcdcde;background:#fff}
.xb-dock-col:last-child{border-right:0}
.xb-dock-col.is-hidden{display:none}
.xb-dock-head{margin:0;display:flex;align-items:center;justify-content:space-between;padding:4px 10px;border-bottom:1px solid #dcdcde;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#50575e;background:#f6f7f7}
.xb-dock-head button{border:0;background:none;cursor:pointer;color:#50575e;font-size:14px}
.xb-dock-body{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:8px}
.xb-dock-body>.xb-insp-code.is-fill{flex:1;min-height:80px;border:1px solid #dcdcde}
`;
document.head.appendChild(style);
register();
if (config) registerDock();
if (config) registerLibrary();
if (config) registerLock();
if (config) registerCommands();
// The page's own look (voce 186), in the canvas from the start.
if (config) void loadPageStyles();
