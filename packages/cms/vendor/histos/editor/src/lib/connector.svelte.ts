// Histeon Connector, builder side (docs/spec/connector.md): when the user clicks "Collega", this tab connects to the
// connector running on their computer (127.0.0.1 only) and carries out the agent's operations through the
// public API (window.xb). Only the operations listed here exist: no code sent by the agent is ever run, and
// nothing can publish. The connection lasts until "Scollega" or the tab closes.
import type { XbApi } from './publicApi.ts';
import { TaskBoard } from './aiTasks.svelte.ts';
import { t } from './i18n.ts';

export const CONNECTOR_PORT = 7341;
export const CONNECTOR_URL = `http://127.0.0.1:${CONNECTOR_PORT}`;
const REMEMBER = 'histos-connector';
/** How long the canvas keeps saying the agent is at work after its last change. */
export const WORKING_MS = 4000;

type Args = Record<string, unknown>;

const text = (a: Args, name: string): string => {
  const v = a[name];
  if (typeof v !== 'string') throw new TypeError(`Serve "${name}" (testo).`);
  return v;
};
const int = (a: Args, name: string): number => {
  const v = a[name];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new TypeError(`Serve "${name}" (numero intero).`);
  return v;
};
const maybe = <T>(a: Args, name: string, read: (a: Args, name: string) => T): T | undefined => (a[name] === undefined || a[name] === null ? undefined : read(a, name));
const object = (a: Args, name: string): Record<string, unknown> => {
  const v = a[name];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`Serve "${name}" (oggetto).`);
  return v as Record<string, unknown>;
};

/** MIME type of an uploaded file from its name: WordPress checks the real type again. */
const MIME_BY_EXTENSION: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg' };

/** A file sent by the agent as base64, as the File an upload takes. */
export function fileFromBase64(name: string, data: string): File {
  if (!/^[^/\\]{1,200}\.[A-Za-z0-9]{2,5}$/.test(name)) throw new TypeError('Serve "name": il nome del file con la sua estensione.');
  const type = MIME_BY_EXTENSION[name.split('.').pop()!.toLowerCase()];
  if (!type) throw new TypeError('Tipo di file non ammesso: immagini, PDF, video e audio.');
  const bytes = Uint8Array.from(atob(data.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type });
}

/**
 * What the agent may change, by area (doc 26 voce 215): the site's administrator turns each on or off in the ✦ panel,
 * and the Abilities of WordPress follow the same choice (plugin/src/Ai/Scopes.php, same keys). Reading, undo, redo
 * and saving in development are always allowed.
 */
export const SCOPES = {
  testi: ['setText'],
  struttura: ['setHtml', 'insert', 'remove', 'move', 'setAttribute', 'applyBem', 'paste'],
  stile: ['setCss'],
  componenti: ['createComponent', 'updateComponent'],
  media: ['uploadMedia', 'setMediaAlt', 'setMediaCollections', 'createCollection', 'updateCollection', 'deleteCollection', 'compressMedia'],
  contenuti: ['updateContent'],
  dati: ['setQuery', 'setSource'],
} as const satisfies Record<string, readonly string[]>;

export type Scope = keyof typeof SCOPES;

export const SCOPE_LABELS: Record<Scope, string> = {
  testi: t('Testi della pagina'),
  struttura: t('Struttura e attributi'),
  stile: t('CSS dei selettori'),
  componenti: t('Componenti'),
  media: t('Libreria dei media (caricare, testi alternativi, raccolte, compressione)'),
  contenuti: t('Contenuti e campi (titolo, riassunto, campi di articoli e record)'),
  dati: t('Query e sorgenti JSON'),
};

/** The area of an operation that changes something, or null for one that only reads. */
export function scopeOf(method: string): Scope | null {
  for (const [scope, methods] of Object.entries(SCOPES) as Array<[Scope, readonly string[]]>) if (methods.includes(method)) return scope;
  return null;
}

/** The operations an agent may ask for, and what they do here. `tasks`: the user's requests from the ✦ panel. */
export function handlers(api: XbApi, tasks: TaskBoard = new TaskBoard(), scopes: () => ReadonlySet<string> = () => new Set(Object.keys(SCOPES))): Record<string, (a: Args) => unknown> {
  const brief = (t: { id: string; kind: string; request: string; instructions: string; status: string }) => ({ id: t.id, kind: t.kind, request: t.request, instructions: t.instructions, status: t.status });
  const all = operations(api, tasks, brief);
  return Object.fromEntries(
    Object.entries(all).map(([method, run]) => {
      const scope = scopeOf(method);
      if (!scope) return [method, run];
      return [
        method,
        (a: Args) => {
          if (!scopes().has(scope)) throw new Error(t('Su questo sito l’agente non può cambiare «{0}»: lo decide l’amministratore nel pannello ✦ del builder, «Cosa può fare l’agente».', SCOPE_LABELS[scope]));
          return run(a);
        },
      ];
    }),
  );
}

function operations(api: XbApi, tasks: TaskBoard, brief: (t: { id: string; kind: string; request: string; instructions: string; status: string }) => unknown): Record<string, (a: Args) => unknown> {
  return {
    nextTask: () => {
      const task = tasks.next();
      return task ? brief(task) : null;
    },
    getTasks: () => tasks.items.filter((t) => t.status !== 'done').map(brief),
    finishTask: (a) => {
      tasks.finish(text(a, 'id'), typeof a.note === 'string' ? a.note : '');
      return { ok: true };
    },
    status: () => ({ connected: true, dirty: api.isDirty(), selection: api.getSelection() }),
    getDocument: () => api.getDocument(),
    getHtml: () => api.getHtml(),
    setHtml: (a) => {
      const html = text(a, 'html');
      api.setHtml(html);
      return { ok: true, warnings: api.lintHtml(html) };
    },
    getTree: () => api.getTree(),
    getSelection: () => api.getSelection(),
    select: (a) => {
      const uid = a.uid ?? null;
      if (uid !== null && typeof uid !== 'string') throw new TypeError('Serve "uid" (testo o null).');
      api.select(uid);
      return { ok: true };
    },
    getElementHtml: (a) => api.getElementHtml(text(a, 'uid')),
    insert: (a) => {
      const html = text(a, 'html');
      return { uids: api.insert(html), warnings: api.lintHtml(html) };
    },
    remove: (a) => {
      api.remove(text(a, 'uid'));
      return { ok: true };
    },
    copy: (a) => {
      const uids = a.uids;
      if (!Array.isArray(uids) || uids.some((u) => typeof u !== 'string')) throw new TypeError('Serve "uids" (lista di uid).');
      return { clip: api.copy(uids as string[]) };
    },
    paste: async (a) => {
      const target = a.target ?? null;
      if (target !== null && typeof target !== 'string') throw new TypeError('Serve "target" (uid o null).');
      const classes = a.classes ?? 'rename';
      if (classes !== 'rename' && classes !== 'keep') throw new TypeError('Serve "classes": rename o keep.');
      return { uids: await api.paste(text(a, 'clip'), { target, classes }) };
    },
    getEnvironment: () => api.environment,
    listMedia: (a) =>
      api.listMedia({
        ...(typeof a.search === 'string' ? { search: a.search } : {}),
        ...(typeof a.type === 'string' ? { type: a.type as 'image' } : {}),
        ...(a.collection !== undefined ? { collection: int(a, 'collection') } : {}),
        ...(a.missingAlt === true ? { missingAlt: true } : {}),
        ...(a.page !== undefined ? { page: int(a, 'page') } : {}),
      }),
    getMedia: (a) => api.getMedia(int(a, 'file')),
    uploadMedia: (a) => api.uploadMedia(fileFromBase64(text(a, 'name'), text(a, 'data')), { ...(a.collection !== undefined ? { collection: int(a, 'collection') } : {}), ...(typeof a.preset === 'string' ? { preset: a.preset } : {}) }),
    setMediaAlt: (a) => api.setMediaAlt(int(a, 'file'), text(a, 'alt')),
    setMediaCollections: (a) => {
      const list = a.collections;
      if (!Array.isArray(list) || list.some((c) => typeof c !== 'number' || !Number.isInteger(c) || c <= 0)) throw new TypeError('Serve "collections" (lista di id).');
      return api.setMediaCollections(int(a, 'file'), list as number[]);
    },
    listCollections: () => api.listCollections(),
    createCollection: (a) => api.createCollection(text(a, 'name'), maybe(a, 'parent', int) ?? 0),
    updateCollection: (a) => api.updateCollection(int(a, 'collection'), { ...(typeof a.name === 'string' ? { name: a.name } : {}), ...(a.parent !== undefined ? { parent: int(a, 'parent') } : {}) }),
    deleteCollection: async (a) => {
      await api.deleteCollection(int(a, 'collection'));
      return { ok: true };
    },
    compressMedia: (a) => api.compressMedia(int(a, 'file'), maybe(a, 'preset', text) ?? 'web'),
    listMediaPresets: () => api.listMediaPresets(),
    searchContent: (a) => api.searchContent(maybe(a, 'search', text) ?? '', maybe(a, 'type', text) ?? '', maybe(a, 'page', int) ?? 1),
    getContent: (a) => api.getContent(int(a, 'content')),
    updateContent: (a) =>
      api.updateContent(int(a, 'content'), {
        ...(a.title !== undefined ? { title: text(a, 'title') } : {}),
        ...(a.excerpt !== undefined ? { excerpt: text(a, 'excerpt') } : {}),
        ...(a.fields !== undefined ? { fields: object(a, 'fields') } : {}),
      }),
    getQuery: (a) => api.getQuery(text(a, 'name')),
    setQuery: async (a) => {
      await api.setQuery(text(a, 'name'), a.query === null ? null : (object(a, 'query') as never));
      return { ok: true };
    },
    getSource: (a) => api.getSource(text(a, 'name')),
    setSource: async (a) => {
      if (!('data' in a)) throw new TypeError('Serve "data" (i dati JSON, o null per togliere la sorgente).');
      await api.setSource(text(a, 'name'), a.data);
      return { ok: true };
    },
    getComponent: (a) => api.getComponent(text(a, 'ref')),
    updateComponent: (a) => api.updateComponent(text(a, 'ref'), { ...(a.html !== undefined ? { html: text(a, 'html') } : {}), ...(a.props !== undefined ? { props: object(a, 'props') as never } : {}) }),
    setText: (a) => {
      api.setText(text(a, 'uid'), text(a, 'text'));
      return { ok: true };
    },
    setAttribute: (a) => {
      const value = a.value === null || a.value === true ? a.value : text(a, 'value');
      api.setAttribute(text(a, 'uid'), text(a, 'name'), value);
      return { ok: true };
    },
    move: (a) => {
      const position = text(a, 'position');
      if (position !== 'before' && position !== 'after' && position !== 'inside') throw new TypeError('Serve "position": before, after o inside.');
      api.move(text(a, 'uid'), text(a, 'target'), position);
      return { ok: true };
    },
    getCss: (a) => api.getCss(text(a, 'selector')),
    setCss: (a) => {
      // The same lint as the CSS panel: the agent sees what it should fix in the answer (I1).
      api.setCss(text(a, 'selector'), text(a, 'css'));
      return { ok: true, warnings: api.lintCss(text(a, 'selector'), text(a, 'css')) };
    },
    getChecks: () => api.getChecks(),
    getView: () => api.getView(),
    listStyles: () => api.listStyles(),
    getFramework: () => api.getFramework(),
    getComponents: () => api.getComponents(),
    getBrief: () => api.getBrief(),
    listSections: () => api.listSections(),
    getSectionBrief: (a) => api.getSectionBrief(text(a, 'id')),
    createComponent: async (a) => {
      await api.createComponent(text(a, 'uid'), text(a, 'ref'), typeof a.title === 'string' ? a.title : '');
      return { ok: true };
    },
    applyBem: (a) => ({ added: api.applyBem(text(a, 'uid')) }),
    render: () => api.render(),
    undo: () => {
      api.undo();
      return { ok: true };
    },
    redo: () => {
      api.redo();
      return { ok: true };
    },
    save: async () => {
      await api.save();
      return { ok: true, dirty: api.isDirty() };
    },
  };
}

export type ConnectorState = 'off' | 'waiting' | 'connected';

/**
 * The commands to paste for the connector (card 30): `pair` takes the secret on stdin into a 0600 file; `serve`
 * and `mcp` read that saved pairing, so the secret is never in the command line of a long-running process.
 */
export function connectorCommands(script: string, pair: { origin: string; secret: string } | null): { pair: string; serve: string; mcp: string } {
  return {
    pair: pair ? `printf '%s' '${pair.secret}' | node ${script} pair --origin ${pair.origin}` : '',
    serve: `node ${script} serve`,
    mcp: `node ${script} mcp`,
  };
}

const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** HMAC-SHA256 with the pairing secret, parts joined by "|", as the connector computes it (pairProof). */
export async function pairProof(secret: string, ...parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(parts.join('|'))));
}

function same(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class ConnectorClient {
  state = $state<ConnectorState>('off');
  /** Recent operations, shown to the user. */
  log = $state<Array<{ at: string; method: string; ok: boolean; error?: string }>>([]);
  /** Why the tab stopped trying (pairing refused, an impostor on the port, no Web Crypto). */
  problem = $state('');
  private tab: { id: string; key: string } | null = null;
  private abort: AbortController | null = null;
  private readonly run: Record<string, (a: Args) => unknown>;
  /** The user's requests for the agent («Chiedi all'agente»). */
  readonly tasks = new TaskBoard();
  /** The areas the agent may change on this site (voce 215), from the server; the panel changes them. */
  scopes = $state<ReadonlySet<string>>(new Set(Object.keys(SCOPES)));
  /** An operation that changed something in the last seconds (voce 219): the canvas says the agent is at work. */
  working = $state<{ method: string; scope: Scope } | null>(null);
  private workingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    api: XbApi,
    private readonly info: () => { site: string; title: string; doc: number; kind: string },
    private readonly pairing: () => string | null = () => null,
  ) {
    this.run = handlers(api, this.tasks, () => this.scopes);
    try {
      if (sessionStorage.getItem(REMEMBER) === '1') this.start();
    } catch {
      // Storage unavailable: the user connects by hand.
    }
  }

  start(): void {
    if (this.state !== 'off') return;
    this.problem = '';
    this.state = 'waiting';
    try {
      sessionStorage.setItem(REMEMBER, '1');
    } catch {
      /* ignore */
    }
    void this.loop();
  }

  stop(): void {
    try {
      sessionStorage.removeItem(REMEMBER);
    } catch {
      /* ignore */
    }
    this.state = 'off';
    this.abort?.abort();
    this.goodbye();
  }

  /** Tells the connector this tab is gone (also on page unload). */
  goodbye(): void {
    const tab = this.tab;
    this.tab = null;
    if (!tab) return;
    // A simple request (no custom header, so no preflight): it survives the page closing.
    const url = `${CONNECTOR_URL}/tab/bye?tab=${encodeURIComponent(tab.id)}`;
    const body = JSON.stringify({ key: tab.key });
    if (!(navigator.sendBeacon && navigator.sendBeacon(url, body))) {
      void fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body }).catch(() => undefined);
    }
  }

  /** Stops trying, with the reason shown in the panel. */
  private refuse(problem: string): void {
    this.problem = problem;
    this.tab = null;
    this.state = 'off';
  }

  /** Read anew each time: stop() may run while a request is pending. */
  private stopped(): boolean {
    return this.state === 'off';
  }

  private async loop(): Promise<void> {
    while (!this.stopped()) {
      this.abort = new AbortController();
      try {
        if (!this.tab) {
          const pair = this.pairing();
          if (!pair || !window.isSecureContext || !globalThis.crypto?.subtle) {
            this.refuse(pair ? t('Il collegamento richiede il builder in HTTPS (o su localhost).') : t('Accoppiamento non disponibile: ricarica il builder.'));
            break;
          }
          const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
          // The time is part of the proof: the connector refuses old hellos, so it need not remember every nonce.
          const time = String(Date.now());
          const proof = await pairProof(pair, 'tab', nonce, window.location.origin, time);
          const res = await fetch(`${CONNECTOR_URL}/tab/hello`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...this.info(), nonce, time, proof }), signal: this.abort.signal });
          if (res.status === 401) {
            this.refuse(t('Il connettore è avviato con un altro accoppiamento: ricopia le istruzioni e riavvialo.'));
            break;
          }
          if (!res.ok) throw new Error(String(res.status));
          const data = (await res.json()) as { tab?: unknown; key?: unknown; proof?: unknown };
          // The connector proves it knows the pairing, for this tab id and key: otherwise it is not ours.
          if (typeof data.tab !== 'string' || typeof data.key !== 'string' || !same(data.proof, await pairProof(pair, 'bridge', nonce, data.tab, data.key))) {
            this.refuse(t('Sulla porta del connettore risponde un programma che non conosce l’accoppiamento: collegamento rifiutato.'));
            break;
          }
          this.tab = { id: data.tab, key: data.key };
          this.state = 'connected';
        }
        const res = await fetch(`${CONNECTOR_URL}/tab/next?tab=${encodeURIComponent(this.tab.id)}`, { headers: { 'X-XB-Tab-Key': this.tab.key }, signal: this.abort.signal });
        if (res.status === 204) continue;
        if (res.status === 401) throw new Error('forgotten');
        if (!res.ok) throw new Error(String(res.status));
        const message = (await res.json()) as { id: string; method: string; args: Args };
        await this.answer(message);
      } catch {
        if (this.stopped()) break;
        // The connector is not running (yet) or restarted: wait and say hello again.
        this.tab = null;
        this.state = 'waiting';
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async answer(message: { id: string; method: string; args: Args }): Promise<void> {
    const tab = this.tab;
    if (!tab) return;
    let body: { id: string; ok: boolean; result?: unknown; error?: string };
    const handler = Object.hasOwn(this.run, message.method) ? this.run[message.method] : undefined;
    try {
      if (!handler) throw new Error(`Operazione non ammessa: ${message.method}`);
      const result = await handler(message.args && typeof message.args === 'object' ? message.args : {});
      body = { id: message.id, ok: true, result: result ?? null };
    } catch (e) {
      body = { id: message.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.log = [{ at: new Date().toLocaleTimeString(), method: message.method, ok: body.ok, error: body.error }, ...this.log].slice(0, 30);
    const scope = scopeOf(message.method);
    if (scope && body.ok) {
      this.working = { method: message.method, scope };
      clearTimeout(this.workingTimer);
      this.workingTimer = setTimeout(() => (this.working = null), WORKING_MS);
    }
    await fetch(`${CONNECTOR_URL}/tab/result?tab=${encodeURIComponent(tab.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XB-Tab-Key': tab.key }, body: JSON.stringify(body) });
  }
}
