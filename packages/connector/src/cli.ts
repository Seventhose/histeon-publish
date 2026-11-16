import { ConnectorClient } from "./client.js";
import { defaultDataDirectory } from "./data-directory.js";
import { ConnectorError, plain } from "./errors.js";
import { runMcp } from "./mcp.js";
import { runTool, type ToolValue } from "./runner.js";

export const GUIDE = `Histeon Publish — connettore AI

Collega un agente (Claude Code, Codex, Claude Desktop, ChatGPT desktop…) a Histeon Publish su questo computer. L'app deve essere
aperta con il connettore attivo (Agente AI → Attiva il connettore). Il comando non contiene segreti.

  mcp                                   server MCP su stdio (per claude mcp add, codex mcp add, Claude Desktop, ChatGPT desktop)
  status                                stato dell'app e del connettore
  projects                              progetti Histeon CMS
  project <id>                          riepilogo di un progetto
  check <file.html> [--download] [--preview] [--severo]
                                        controlla un prototipo senza importarlo (--preview: anche l'anteprima; --severo: le regole delle guide)
  import <file.html> [--update] [--download]
                                        importa un prototipo; con --update chiede all'utente di aggiornare il progetto
  import-status <requestId> [--wait s]  stato di un aggiornamento in attesa dell'utente
  choices [--wait s]                   la domanda sui nomi di un'importazione HTML che aspetta l'agente
  choices-answer <requestId> <json>     risponde alla domanda sui nomi: {"scelte":[{"id":"…","valore":"…"}]}
  build <id> [--page <alias>]           costruisce il sito e dà l'anteprima
  builds <id>                           build del progetto
  file <id> <buildId> [percorso]        un file di testo della build
  export <id>                           esporta il progetto come .xbsite
  wordpress                             siti WordPress collegati e permessi
  push <id> <connectionId> [--dry-run]  invia IN SVILUPPO a WordPress, se permesso
  push-status <requestId> [--wait s]    stato di un invio
  manual [sezione]                      il manuale per scrivere prototipi
  docs [argomento]                      la documentazione di Histeon per argomento (senza: l'indice)
  call <strumento> '<json>'             qualsiasi strumento hp_* con argomenti JSON

Opzioni: --data-dir <cartella> se Histeon Publish usa una cartella dati diversa da quella predefinita.
Uscita: 0 riuscito, 2 contenuto rifiutato (prototipo non valido, conflitto…), 1 altro errore.
`;

interface Parsed {
  flags: { dataDir?: string; download?: boolean; update?: boolean; preview?: boolean; strict?: boolean; dryRun?: boolean; page?: string; wait?: string };
  rest: string[];
}

function parseArgs(argv: readonly string[]): Parsed {
  const flags: Parsed["flags"] = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) throw new ConnectorError("connector-usage", `Manca il valore di ${arg}.`);
      return next;
    };
    if (arg === "--data-dir") flags.dataDir = value();
    else if (arg === "--download") flags.download = true;
    else if (arg === "--update") flags.update = true;
    else if (arg === "--preview") flags.preview = true;
    else if (arg === "--severo") flags.strict = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--page") flags.page = value();
    else if (arg === "--wait") flags.wait = value();
    else if (arg.startsWith("--")) throw new ConnectorError("connector-usage", `Opzione sconosciuta: ${plain(arg, 60)}. Vedi help.`);
    else rest.push(arg);
  }
  return { flags, rest };
}

const integer = (value: string | undefined): number | string | undefined => value === undefined ? undefined : /^[0-9]{1,10}$/u.test(value) ? Number(value) : value;

function need(value: string | undefined, what: string): string {
  if (!value) throw new ConnectorError("connector-usage", `Manca ${what}. Vedi help.`);
  return value;
}

/** Turns a CLI command into a tool call: the same tools, checks and answers as MCP. */
function toTool(command: string, rest: readonly string[], flags: Parsed["flags"]): [string, Record<string, unknown>] | null {
  const only = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
  switch (command) {
    case "status": return ["hp_status", {}];
    case "projects": return ["hp_list_projects", {}];
    case "project": return ["hp_project", { projectId: need(rest[0], "l'id del progetto") }];
    case "check": return ["hp_check_prototype", only({ path: need(rest[0], "il file del prototipo"), downloadRemoteMedia: flags.download, preview: flags.preview, strict: flags.strict })];
    case "import": return ["hp_import_prototype", only({ path: need(rest[0], "il file del prototipo"), update: flags.update, downloadRemoteMedia: flags.download })];
    case "import-status": return ["hp_import_status", only({ requestId: need(rest[0], "l'id della richiesta"), waitSeconds: integer(flags.wait) })];
    case "choices": return ["hp_import_choices", only({ waitSeconds: integer(flags.wait) })];
    case "choices-answer": return ["hp_import_choices_answer", { requestId: need(rest[0], "l'id della domanda"), scelte: need(rest[1], "le scelte in JSON") }];
    case "build": return ["hp_build", only({ projectId: need(rest[0], "l'id del progetto"), page: integer(flags.page) })];
    case "builds": return ["hp_builds", { projectId: need(rest[0], "l'id del progetto") }];
    case "file": return ["hp_build_file", only({ projectId: need(rest[0], "l'id del progetto"), buildId: need(rest[1], "l'id della build"), path: rest[2] })];
    case "export": return ["hp_export_xbsite", { projectId: need(rest[0], "l'id del progetto") }];
    case "wordpress": return ["hp_list_wordpress", {}];
    case "push": return ["hp_wordpress_push", only({ projectId: need(rest[0], "l'id del progetto"), connectionId: need(rest[1], "l'id del collegamento WordPress"), dryRun: flags.dryRun })];
    case "push-status": return ["hp_wordpress_push_status", only({ requestId: need(rest[0], "l'id della richiesta"), waitSeconds: integer(flags.wait) })];
    case "translation-brief": return ["hp_translation_brief", { projectId: need(rest[0], "l'id del progetto") }];
    case "translation-work": return ["hp_translation_work", only({ projectId: need(rest[0], "l'id del progetto"), language: need(rest[1], "la lingua") })];
    case "translation-source": return ["hp_translation_source", { projectId: need(rest[0], "l'id del progetto"), sourceId: need(rest[1], "l'id dell'originale"), language: need(rest[2], "la lingua") }];
    case "translation-save": return ["hp_translation_save", { projectId: need(rest[0], "l'id del progetto"), sourceId: need(rest[1], "l'id dell'originale"), language: need(rest[2], "la lingua"), segments: need(rest[3], "i testi in JSON") }];
    case "manual": return ["hp_manual", only({ section: rest[0] })];
    case "docs": return ["hp_docs", only({ topic: rest[0] })];
    case "call": {
      let args: unknown = {};
      if (rest[1] !== undefined) {
        try {
          args = JSON.parse(rest[1]);
        } catch {
          throw new ConnectorError("connector-usage", "Argomenti JSON non validi.");
        }
      }
      return [need(rest[0], "lo strumento"), args as Record<string, unknown>];
    }
    default: return null;
  }
}

export interface MainOptions {
  version: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  cwd?: string;
}

/** `histos-publish-connector <command>` (and `histos-publish mcp`): returns the exit code. */
export async function main(argv: readonly string[], options: MainOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const [command, ...tail] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      stdout.write(GUIDE);
      return 0;
    }
    if (command === "version" || command === "--version") {
      stdout.write(`${options.version}\n`);
      return 0;
    }
    const { flags, rest } = parseArgs(tail);
    const dataDirectory = flags.dataDir ? flags.dataDir : defaultDataDirectory();
    if (command === "mcp") {
      await runMcp({ dataDirectory, version: options.version, ...(options.cwd ? { cwd: options.cwd } : {}) });
      return 0;
    }
    const call = toTool(command, rest, flags);
    if (!call) {
      stderr.write(`Comando sconosciuto: ${plain(command, 60)}. Vedi help.\n`);
      return 1;
    }
    const client = new ConnectorClient({ dataDirectory, client: "cli" });
    const value: ToolValue = await runTool(call[0], call[1], { client, cwd: options.cwd ?? process.cwd() });
    if (typeof value === "string") stdout.write(value.endsWith("\n") ? value : `${value}\n`);
    else if (command === "file" && typeof value.text === "string") stdout.write(value.text);
    else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return 0;
  } catch (error) {
    const known = error instanceof ConnectorError ? error : new ConnectorError("connector-internal", plain(error instanceof Error ? error.message : String(error), 500));
    stderr.write(`${known.code}: ${known.message}\n`);
    if (known.details) stderr.write(`${JSON.stringify(known.details, null, 2)}\n`);
    return known.exitCode;
  }
}
