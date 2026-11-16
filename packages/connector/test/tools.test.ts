import { describe, expect, it } from "vitest";
import { ConnectorClient } from "../src/client.js";
import { ConnectorError } from "../src/errors.js";
import { manualSection, PROTOTYPE_AI_MANUAL } from "../src/manual.js";
import { findTool, runTool } from "../src/runner.js";
import { BUILD_PATH_PATTERN, CALL_OPERATIONS, isCallOperation, MANUAL_SECTIONS, type ObjectSchema, schemaProblem, TOOLS, UUID_PATTERN } from "../src/tools.js";

const PROJECT = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const BUILD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const schemaOf = (name: string): ObjectSchema => {
  const tool = findTool(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.inputSchema;
};

describe("the closed tool list", () => {
  // Golden snapshot: adding, removing or widening an operation must fail here first, then be reviewed against the
  // security section of the design (16-connettore-ai.md) before the snapshot is updated.
  it("matches the golden snapshot of tools and call operations", () => {
    const tools = TOOLS.map((tool) => ({ name: tool.name, via: tool.via, inputSchema: tool.inputSchema }));
    const operations = Object.fromEntries(Object.entries(CALL_OPERATIONS).map(([name, operation]) => [name, { heavy: operation.heavy, schema: operation.schema }]));
    expect(JSON.parse(JSON.stringify({ tools, operations }))).toMatchInlineSnapshot(`
      {
        "operations": {
          "articlePropose": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "alias": {
                  "maximum": 2147483647,
                  "minimum": 1,
                  "type": "integer",
                },
                "blocks": {
                  "description": "Elenco JSON dei blocchi dell'articolo come li dà hp_article_read.",
                  "maxLength": 4194304,
                  "minLength": 2,
                  "type": "string",
                },
                "excerpt": {
                  "maxLength": 2000,
                  "minLength": 1,
                  "type": "string",
                },
                "head": {
                  "maxLength": 200,
                  "minLength": 1,
                  "type": "string",
                },
                "note": {
                  "maxLength": 1000,
                  "minLength": 1,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "title": {
                  "maxLength": 500,
                  "minLength": 1,
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "alias",
                "head",
              ],
              "type": "object",
            },
          },
          "articleRead": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "alias": {
                  "maximum": 2147483647,
                  "minimum": 1,
                  "type": "integer",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "alias",
              ],
              "type": "object",
            },
          },
          "build": {
            "heavy": true,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "page": {
                  "maximum": 2147483647,
                  "minimum": 1,
                  "type": "integer",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
          },
          "exportXbsite": {
            "heavy": true,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
          },
          "getProject": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
          },
          "importChoices": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "waitSeconds": {
                  "maximum": 50,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "type": "object",
            },
          },
          "importChoicesAnswer": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "requestId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "scelte": {
                  "description": "Il testo JSON {"scelte":[{"id":"…","valore":"…"}]}, una voce per ogni id della domanda.",
                  "maxLength": 262144,
                  "minLength": 2,
                  "type": "string",
                },
              },
              "required": [
                "requestId",
                "scelte",
              ],
              "type": "object",
            },
          },
          "importStatus": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "requestId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "waitSeconds": {
                  "maximum": 50,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "requestId",
              ],
              "type": "object",
            },
          },
          "listBuilds": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
          },
          "listProjects": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "limit": {
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
              },
              "type": "object",
            },
          },
          "listWordPress": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
          },
          "readBuildFile": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "buildId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "path": {
                  "maxLength": 300,
                  "pattern": "^(?!.*(?:^|/)\\.)(?!.*//)[A-Za-z0-9_~-][A-Za-z0-9._~/-]{0,299}$",
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "buildId",
              ],
              "type": "object",
            },
          },
          "status": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
          },
          "translationBrief": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
          },
          "translationSave": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "segments": {
                  "description": "Oggetto JSON id del testo → testo tradotto.",
                  "maxLength": 4194304,
                  "minLength": 2,
                  "type": "string",
                },
                "slug": {
                  "maxLength": 200,
                  "minLength": 1,
                  "type": "string",
                },
                "sourceId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "sourceId",
                "language",
                "segments",
              ],
              "type": "object",
            },
          },
          "translationSaveStrings": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "strings": {
                  "description": "Elenco JSON di oggetti { source, translation, context }.",
                  "maxLength": 4194304,
                  "minLength": 2,
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "language",
                "strings",
              ],
              "type": "object",
            },
          },
          "translationSource": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "sourceId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "sourceId",
                "language",
              ],
              "type": "object",
            },
          },
          "translationStrings": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "state": {
                  "enum": [
                    "missing",
                    "draft",
                    "published",
                  ],
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "language",
              ],
              "type": "object",
            },
          },
          "translationWork": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "limit": {
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "state": {
                  "enum": [
                    "missing",
                    "draft",
                    "stale",
                    "published",
                  ],
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "language",
              ],
              "type": "object",
            },
          },
          "wordpressPush": {
            "heavy": true,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "connectionId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "dryRun": {
                  "type": "boolean",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "connectionId",
              ],
              "type": "object",
            },
          },
          "wordpressPushStatus": {
            "heavy": false,
            "schema": {
              "additionalProperties": false,
              "properties": {
                "requestId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "waitSeconds": {
                  "maximum": 50,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "requestId",
              ],
              "type": "object",
            },
          },
        },
        "tools": [
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "section": {
                  "enum": [
                    "tutto",
                    "flusso",
                    "regole",
                    "trappole",
                    "limiti",
                    "modellazione",
                    "javascript",
                    "caratteri",
                    "wordpress",
                    "errori",
                    "fatto",
                    "agenti",
                    "scheletro",
                    "proposta",
                    "contenuti",
                    "template",
                    "stile",
                    "markup",
                    "accessibilita",
                    "controllo",
                    "connettore",
                  ],
                  "type": "string",
                },
              },
              "type": "object",
            },
            "name": "hp_manual",
            "via": {
              "kind": "local",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "topic": {
                  "enum": [
                    "indice",
                    "rapido",
                    "ecosistema",
                    "metodo",
                    "sintassi",
                    "dati",
                    "componenti",
                    "stile",
                    "histos-css",
                    "acss",
                    "core-framework",
                    "etch",
                    "markup",
                    "prototipi",
                    "wordpress",
                    "errori-tipici",
                    "accessibilita",
                    "controllo",
                    "mestiere",
                    "progettare",
                    "design",
                    "ricetta-scrivere",
                    "ricetta-importare",
                    "ricetta-aggiornare",
                    "ricetta-wordpress",
                    "ricetta-tradurre",
                    "ricetta-correggere",
                    "ricetta-design",
                  ],
                  "type": "string",
                },
              },
              "type": "object",
            },
            "name": "hp_docs",
            "via": {
              "kind": "local",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "kit": {
                  "description": "minimo (predefinito) o sito.",
                  "enum": [
                    "minimo",
                    "sito",
                  ],
                  "type": "string",
                },
                "name": {
                  "description": "Il nome del progetto, nel manifest e nel <title>.",
                  "maxLength": 120,
                  "minLength": 1,
                  "type": "string",
                },
                "path": {
                  "description": "Dove scrivere il kit: un file .html che non esiste ancora (assoluto o relativo alla cartella di lavoro dell'agente).",
                  "maxLength": 4096,
                  "minLength": 1,
                  "type": "string",
                },
              },
              "type": "object",
            },
            "name": "hp_prototype_init",
            "via": {
              "kind": "local",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "hp_status",
            "via": {
              "kind": "call",
              "operation": "status",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "limit": {
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
              },
              "type": "object",
            },
            "name": "hp_list_projects",
            "via": {
              "kind": "call",
              "operation": "listProjects",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
            "name": "hp_project",
            "via": {
              "kind": "call",
              "operation": "getProject",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "downloadRemoteMedia": {
                  "description": "Scarica anche i media con url https (spento: nel controllo diventano segnaposto, nell'import l'import si ferma).",
                  "type": "boolean",
                },
                "html": {
                  "description": "Il prototipo come testo, solo se non puoi indicare un file (al massimo 4 MiB).",
                  "maxLength": 4194304,
                  "minLength": 1,
                  "type": "string",
                },
                "path": {
                  "description": "Percorso del file .html del prototipo (assoluto o relativo alla cartella di lavoro dell'agente). Preferiscilo a html.",
                  "maxLength": 4096,
                  "minLength": 1,
                  "type": "string",
                },
                "preview": {
                  "description": "Costruisce anche il sito in un'anteprima usa-e-getta, senza creare il progetto, e trova gli errori della sola build: un sito che non si costruisce rende il prototipo non valido («La versione del sito si ferma: …»). preview.previewUrl è per l'utente (vale 5 minuti, i file si cancellano dopo 15); preview.status unavailable con reason dice perché non c'è (nessuna pagina pubblicata, limite orario, disco; o i controlli di pubblicazione, con i motivi fra gli avvisi), e il prototipo resta valido. Conta anche come build nel limite orario.",
                  "type": "boolean",
                },
                "strict": {
                  "description": "Controllo severo: le regole delle guide (classi BEM, niente utility né stili in linea, niente lorem ipsum, schede ripetute come componenti, loop su liste con {:else}, campi che esistono) e ogni avviso da correggere diventano problemi. La risposta ha strict.passed (vero solo senza problemi di livello errore) e strict.problems, ognuno con rule, level, document, line, message e fix. Correggi e ricontrolla finché strict.passed è true.",
                  "type": "boolean",
                },
              },
              "type": "object",
            },
            "name": "hp_check_prototype",
            "via": {
              "kind": "prototype",
              "mode": "check",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "downloadRemoteMedia": {
                  "description": "Scarica anche i media con url https (spento: nel controllo diventano segnaposto, nell'import l'import si ferma).",
                  "type": "boolean",
                },
                "html": {
                  "description": "Il prototipo come testo, solo se non puoi indicare un file (al massimo 4 MiB).",
                  "maxLength": 4194304,
                  "minLength": 1,
                  "type": "string",
                },
                "path": {
                  "description": "Percorso del file .html del prototipo (assoluto o relativo alla cartella di lavoro dell'agente). Preferiscilo a html.",
                  "maxLength": 4096,
                  "minLength": 1,
                  "type": "string",
                },
                "update": {
                  "description": "Aggiorna il progetto creato dallo stesso prototipo. Non lo fa subito: crea una richiesta che l'utente approva in Histeon Publish, con cosa cambia; prima dell'aggiornamento si salva un backup.",
                  "type": "boolean",
                },
              },
              "type": "object",
            },
            "name": "hp_import_prototype",
            "via": {
              "kind": "prototype",
              "mode": "import",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "waitSeconds": {
                  "maximum": 50,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "type": "object",
            },
            "name": "hp_import_choices",
            "via": {
              "kind": "call",
              "operation": "importChoices",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "requestId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "scelte": {
                  "description": "Il testo JSON {"scelte":[{"id":"…","valore":"…"}]}, una voce per ogni id della domanda.",
                  "maxLength": 262144,
                  "minLength": 2,
                  "type": "string",
                },
              },
              "required": [
                "requestId",
                "scelte",
              ],
              "type": "object",
            },
            "name": "hp_import_choices_answer",
            "via": {
              "kind": "call",
              "operation": "importChoicesAnswer",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "requestId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "waitSeconds": {
                  "maximum": 50,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "requestId",
              ],
              "type": "object",
            },
            "name": "hp_import_status",
            "via": {
              "kind": "call",
              "operation": "importStatus",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "page": {
                  "maximum": 2147483647,
                  "minimum": 1,
                  "type": "integer",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
            "name": "hp_build",
            "via": {
              "kind": "call",
              "operation": "build",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
            "name": "hp_builds",
            "via": {
              "kind": "call",
              "operation": "listBuilds",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "buildId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "path": {
                  "maxLength": 300,
                  "pattern": "^(?!.*(?:^|/)\\.)(?!.*//)[A-Za-z0-9_~-][A-Za-z0-9._~/-]{0,299}$",
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "buildId",
              ],
              "type": "object",
            },
            "name": "hp_build_file",
            "via": {
              "kind": "call",
              "operation": "readBuildFile",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
            "name": "hp_export_xbsite",
            "via": {
              "kind": "call",
              "operation": "exportXbsite",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "hp_list_wordpress",
            "via": {
              "kind": "call",
              "operation": "listWordPress",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "connectionId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "dryRun": {
                  "type": "boolean",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "connectionId",
              ],
              "type": "object",
            },
            "name": "hp_wordpress_push",
            "via": {
              "kind": "call",
              "operation": "wordpressPush",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
              ],
              "type": "object",
            },
            "name": "hp_translation_brief",
            "via": {
              "kind": "call",
              "operation": "translationBrief",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "limit": {
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "state": {
                  "enum": [
                    "missing",
                    "draft",
                    "stale",
                    "published",
                  ],
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "language",
              ],
              "type": "object",
            },
            "name": "hp_translation_work",
            "via": {
              "kind": "call",
              "operation": "translationWork",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "sourceId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "sourceId",
                "language",
              ],
              "type": "object",
            },
            "name": "hp_translation_source",
            "via": {
              "kind": "call",
              "operation": "translationSource",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "segments": {
                  "description": "Oggetto JSON id del testo → testo tradotto.",
                  "maxLength": 4194304,
                  "minLength": 2,
                  "type": "string",
                },
                "slug": {
                  "maxLength": 200,
                  "minLength": 1,
                  "type": "string",
                },
                "sourceId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "sourceId",
                "language",
                "segments",
              ],
              "type": "object",
            },
            "name": "hp_translation_save",
            "via": {
              "kind": "call",
              "operation": "translationSave",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "state": {
                  "enum": [
                    "missing",
                    "draft",
                    "published",
                  ],
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "language",
              ],
              "type": "object",
            },
            "name": "hp_translation_strings",
            "via": {
              "kind": "call",
              "operation": "translationStrings",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "language": {
                  "maxLength": 35,
                  "minLength": 2,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "strings": {
                  "description": "Elenco JSON di oggetti { source, translation, context }.",
                  "maxLength": 4194304,
                  "minLength": 2,
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "language",
                "strings",
              ],
              "type": "object",
            },
            "name": "hp_translation_save_strings",
            "via": {
              "kind": "call",
              "operation": "translationSaveStrings",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "alias": {
                  "maximum": 2147483647,
                  "minimum": 1,
                  "type": "integer",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "alias",
              ],
              "type": "object",
            },
            "name": "hp_article_read",
            "via": {
              "kind": "call",
              "operation": "articleRead",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "alias": {
                  "maximum": 2147483647,
                  "minimum": 1,
                  "type": "integer",
                },
                "blocks": {
                  "description": "Elenco JSON dei blocchi dell'articolo come li dà hp_article_read.",
                  "maxLength": 4194304,
                  "minLength": 2,
                  "type": "string",
                },
                "excerpt": {
                  "maxLength": 2000,
                  "minLength": 1,
                  "type": "string",
                },
                "head": {
                  "maxLength": 200,
                  "minLength": 1,
                  "type": "string",
                },
                "note": {
                  "maxLength": 1000,
                  "minLength": 1,
                  "type": "string",
                },
                "projectId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "title": {
                  "maxLength": 500,
                  "minLength": 1,
                  "type": "string",
                },
              },
              "required": [
                "projectId",
                "alias",
                "head",
              ],
              "type": "object",
            },
            "name": "hp_article_propose",
            "via": {
              "kind": "call",
              "operation": "articlePropose",
            },
          },
          {
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "requestId": {
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                  "type": "string",
                },
                "waitSeconds": {
                  "maximum": 50,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "requestId",
              ],
              "type": "object",
            },
            "name": "hp_wordpress_push_status",
            "via": {
              "kind": "call",
              "operation": "wordpressPushStatus",
            },
          },
        ],
      }
    `);
  });

  it("names every tool once, with the hp_ prefix and an Italian description", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^hp_[a-z_]+$/u);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("exposes every call operation through exactly one tool, with the operation's own schema", () => {
    const calls = TOOLS.flatMap((tool) => (tool.via.kind === "call" ? [tool] : []));
    expect(calls.map((tool) => (tool.via.kind === "call" ? tool.via.operation : "")).sort()).toEqual(Object.keys(CALL_OPERATIONS).sort());
    for (const tool of calls) if (tool.via.kind === "call") expect(tool.inputSchema).toBe(CALL_OPERATIONS[tool.via.operation].schema);
  });

  it("has nothing that publishes, deploys, deletes or reads settings", () => {
    const words = [...TOOLS.map((tool) => tool.name), ...Object.keys(CALL_OPERATIONS)].join(" ").toLowerCase();
    for (const word of ["publish", "deploy", "delete", "remove", "setting", "secret", "token", "credential", "shell", "exec"]) expect(words).not.toContain(word);
  });

  it("knows only its own operations, never inherited names", () => {
    expect(isCallOperation("status")).toBe(true);
    for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty", "deploy", "", 1, null]) expect(isCallOperation(name)).toBe(false);
    expect(findTool("toString")).toBeUndefined();
    expect(findTool(42)).toBeUndefined();
  });

  it("keeps the manual sections in chapter order", () => {
    expect(MANUAL_SECTIONS[0]).toBe("tutto");
    expect(MANUAL_SECTIONS[11]).toBe("agenti");
    expect(MANUAL_SECTIONS[20]).toBe("connettore");
    // Each name opens its own chapter: the manual's list at the top says which number goes with which name.
    for (const [index, section] of MANUAL_SECTIONS.entries()) {
      if (index === 0) continue;
      expect(manualSection(section), section).toContain(`\n## ${index}. `);
      expect(PROTOTYPE_AI_MANUAL.split("\n---\n")[0], section).toContain(`${index} \`${section}\``);
    }
  });
});

describe("schemaProblem", () => {
  it("accepts valid arguments", () => {
    expect(schemaProblem(CALL_OPERATIONS.status.schema, {})).toBeNull();
    expect(schemaProblem(CALL_OPERATIONS.build.schema, { projectId: PROJECT, page: 3 })).toBeNull();
    expect(schemaProblem(CALL_OPERATIONS.readBuildFile.schema, { projectId: PROJECT, buildId: BUILD, path: "blog/index.html" })).toBeNull();
    expect(schemaProblem(CALL_OPERATIONS.wordpressPush.schema, { projectId: PROJECT, connectionId: BUILD, dryRun: true })).toBeNull();
    expect(schemaProblem(schemaOf("hp_manual"), { section: "connettore" })).toBeNull();
  });

  it.each([null, undefined, [], "x", 1, true])("refuses arguments that are not an object (%j)", (value) => {
    expect(schemaProblem(CALL_OPERATIONS.status.schema, value)).toBe("gli argomenti devono essere un oggetto");
  });

  it("refuses an extra argument, including inherited and prototype names", () => {
    expect(schemaProblem(CALL_OPERATIONS.status.schema, { extra: 1 })).toBe("argomento sconosciuto: extra");
    expect(schemaProblem(CALL_OPERATIONS.getProject.schema, { projectId: PROJECT, projectID: PROJECT })).toBe("argomento sconosciuto: projectID");
    expect(schemaProblem(CALL_OPERATIONS.status.schema, JSON.parse('{"__proto__":{"polluted":true}}'))).toBe("argomento sconosciuto: __proto__");
    expect(schemaProblem(CALL_OPERATIONS.status.schema, { toString: "x" })).toBe("argomento sconosciuto: toString");
    expect(schemaProblem(CALL_OPERATIONS.status.schema, { constructor: "x" })).toBe("argomento sconosciuto: constructor");
    // The name is shortened in the message, so an agent cannot fill the error with its own text.
    expect(schemaProblem(CALL_OPERATIONS.status.schema, { ["a".repeat(500)]: 1 })).toBe(`argomento sconosciuto: ${"a".repeat(60)}`);
  });

  it("refuses a wrong type", () => {
    expect(schemaProblem(CALL_OPERATIONS.getProject.schema, { projectId: 42 })).toBe("projectId deve essere un testo");
    expect(schemaProblem(CALL_OPERATIONS.wordpressPush.schema, { projectId: PROJECT, connectionId: BUILD, dryRun: "true" })).toBe("dryRun deve essere true o false");
    expect(schemaProblem(CALL_OPERATIONS.wordpressPush.schema, { projectId: PROJECT, connectionId: BUILD, dryRun: 1 })).toBe("dryRun deve essere true o false");
    expect(schemaProblem(CALL_OPERATIONS.listProjects.schema, { limit: "5" })).toBe("limit deve essere un intero fra 1 e 200");
    expect(schemaProblem(CALL_OPERATIONS.getProject.schema, { projectId: [PROJECT] })).toBe("projectId deve essere un testo");
  });

  it("refuses a missing required argument", () => {
    expect(schemaProblem(CALL_OPERATIONS.getProject.schema, {})).toBe("manca l'argomento projectId");
    expect(schemaProblem(CALL_OPERATIONS.wordpressPush.schema, { projectId: PROJECT })).toBe("manca l'argomento connectionId");
    expect(schemaProblem(CALL_OPERATIONS.getProject.schema, { projectId: undefined })).toBe("manca l'argomento projectId");
  });

  it("enforces integer bounds and refuses non-integers", () => {
    const limit = CALL_OPERATIONS.listProjects.schema;
    expect(schemaProblem(limit, { limit: 1 })).toBeNull();
    expect(schemaProblem(limit, { limit: 200 })).toBeNull();
    for (const value of [0, 201, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(schemaProblem(limit, { limit: value })).toBe("limit deve essere un intero fra 1 e 200");
    }
    const wait = CALL_OPERATIONS.wordpressPushStatus.schema;
    expect(schemaProblem(wait, { requestId: PROJECT, waitSeconds: 0 })).toBeNull();
    expect(schemaProblem(wait, { requestId: PROJECT, waitSeconds: 50 })).toBeNull();
    expect(schemaProblem(wait, { requestId: PROJECT, waitSeconds: 51 })).toBe("waitSeconds deve essere un intero fra 0 e 50");
    expect(schemaProblem(CALL_OPERATIONS.build.schema, { projectId: PROJECT, page: 2_147_483_648 })).toBe("page deve essere un intero fra 1 e 2147483647");
  });

  it("enforces patterns: UUIDs and build paths", () => {
    const project = CALL_OPERATIONS.getProject.schema;
    for (const value of [PROJECT.toUpperCase(), `${PROJECT} `, `${PROJECT}\n`, "not-a-uuid", "", "3f2b8c1e-9a4d-0e6f-8b7a-1c2d3e4f5a6b", "3f2b8c1e-9a4d-4e6f-cb7a-1c2d3e4f5a6b"]) {
      expect(schemaProblem(project, { projectId: value })).toBe("projectId non ha il formato atteso");
    }
    expect(new RegExp(UUID_PATTERN, "u").test(PROJECT)).toBe(true);
    const file = CALL_OPERATIONS.readBuildFile.schema;
    for (const value of ["index.html", "blog/articolo/index.html", "blog/articolo/", "assets/css/site.css", "sitemap.xml", "a~b/c_d-e.txt"]) {
      expect(schemaProblem(file, { projectId: PROJECT, buildId: BUILD, path: value })).toBeNull();
    }
    for (const value of ["../segreto.txt", "blog/../../x", ".env", "blog/.htaccess", "a\\b", "a%2e%2e/b", "a?b", "a b", "", "à.html", ".", "./index.html", "/etc/passwd", "/blog/articolo/index.html", "blog//index.html"]) {
      expect(schemaProblem(file, { projectId: PROJECT, buildId: BUILD, path: value }), value).not.toBeNull();
    }
    expect(new RegExp(BUILD_PATH_PATTERN, "u").test("a".repeat(300))).toBe(true);
    expect(schemaProblem(file, { projectId: PROJECT, buildId: BUILD, path: "a".repeat(301) })).toBe("path è troppo lungo");
  });

  it("enforces enums and lengths", () => {
    expect(schemaProblem(schemaOf("hp_manual"), { section: "segreti" })).toBe(`section deve essere uno di: ${MANUAL_SECTIONS.join(", ")}`);
    expect(schemaProblem(schemaOf("hp_manual"), { section: "Connettore" })).not.toBeNull();
    expect(schemaProblem(schemaOf("hp_check_prototype"), { path: "" })).toBe("path è troppo corto");
    expect(schemaProblem(schemaOf("hp_check_prototype"), { path: "a".repeat(4097) })).toBe("path è troppo lungo");
    expect(schemaProblem(schemaOf("hp_check_prototype"), { path: "p.html", update: true })).toBe("argomento sconosciuto: update");
    expect(schemaProblem(schemaOf("hp_import_prototype"), { path: "p.html", update: true })).toBeNull();
  });
});

describe("runTool argument checks (before any request)", () => {
  // A client pointed at a folder with no session: if anything reached it, the error would be connector-off.
  const client = new ConnectorClient({ dataDirectory: "/nonexistent-histos-publish-data" });

  it("refuses an unknown tool with the list of tools, exit code 2", async () => {
    const error = await runTool("hp_deploy", {}, { client, cwd: "/" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("connector-unknown-tool");
    expect((error as ConnectorError).exitCode).toBe(2);
    expect((error as ConnectorError).message).toContain("hp_manual");
  });

  it("refuses invalid arguments before contacting the app", async () => {
    const error = await runTool("hp_project", { projectId: "x" }, { client, cwd: "/" }).catch((caught: unknown) => caught);
    expect((error as ConnectorError).code).toBe("connector-invalid-arguments");
    expect((error as ConnectorError).message).toBe("projectId non ha il formato atteso");
    expect((error as ConnectorError).exitCode).toBe(2);
  });

  it("needs exactly one of path and html for a prototype", async () => {
    for (const args of [{}, { path: "p.html", html: "<html>" }]) {
      const error = await runTool("hp_check_prototype", args, { client, cwd: "/" }).catch((caught: unknown) => caught);
      expect((error as ConnectorError).code).toBe("connector-invalid-arguments");
    }
  });

  it("treats missing arguments as an empty object", async () => {
    expect(await runTool("hp_manual", undefined, { client, cwd: "/" })).toContain("# Prototipo Histeon");
    expect(await runTool("hp_manual", null, { client, cwd: "/" })).toContain("# Prototipo Histeon");
  });
});
