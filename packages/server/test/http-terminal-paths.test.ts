import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hideFilePaths } from "../src/http.js";

const HIDDEN = "[percorso rimosso]";

/**
 * Runs `check` with `home` as the user's home folder (os.homedir() reads HOME, USERPROFILE on Windows, on every call)
 * and no other default data folder. A data folder of a test goes in hideFilePaths' `folders`, as written.
 */
function withHome(home: string, check: () => void): void {
  const keys = ["HOME", "USERPROFILE", "HISTOS_PUBLISH_DATA_DIR", "XDG_DATA_HOME", "APPDATA"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of ["HISTOS_PUBLISH_DATA_DIR", "XDG_DATA_HOME", "APPDATA"] as const) delete process.env[key];
  try { check(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Each [text, hidden] of `cases` with `home` (and `data`, the data folder). */
function expectHidden(home: string, cases: ReadonlyArray<readonly [string, string]>, data?: string): void {
  withHome(home, () => {
    for (const [text, hidden] of cases) expect(hideFilePaths(text, undefined, data ? [data] : []), JSON.stringify(text)).toBe(hidden);
  });
}

/** `text` in `levels` JSON strings, one in the other. */
const nested = (text: string, levels: number) => {
  let value = text;
  for (let level = 0; level < levels; level += 1) value = JSON.stringify(value);
  return value;
};

/** `text` with every escape decoded as often as it takes and every backslash gone: what a reader may still make of it. */
const flattened = (text: string) => {
  let value = text;
  for (let pass = 0; pass < 8; pass += 1) value = value.replace(/\\+(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/gu, (_, unit, byte) => String.fromCharCode(Number.parseInt(unit ?? byte, 16)));
  return value.replaceAll("\\", "").toLowerCase();
};

describe("percorsi nei messaggi per l'agente: sequenze del terminale e messaggi oltre tre decodifiche (S8)", () => {
  it("una sequenza senza il suo byte finale non prende la barra del percorso: ESC, ESC (, ESC [, CSI a 8 bit (S8-incompleta)", () => {
    // Before (round 7): the "/" of the path was read as an intermediate byte and its letter as the final one, and the
    // whole home went out in every one of these.
    expectHidden("/home/anna rossi", [
      ["Errore \u009b/home/anna rossi/x", `Errore \u009b${HIDDEN}`],
      ["Errore \u001b(/home/anna rossi/x", `Errore \u001b(${HIDDEN}`],
      ["Errore \u001b[/home/anna rossi/x", `Errore \u001b[${HIDDEN}`],
      ["Errore \u001b/home/anna rossi/x", `Errore \u001b${HIDDEN}`],
      ["Errore \u001b[ /home/anna rossi/x", `Errore \u001b[ ${HIDDEN}`],
      ["Errore\u001b[31/home/anna rossi/x", `Errore\u001b[31${HIDDEN}`],
      ["Errore\u009b?/home/anna rossi/x", `Errore\u009b?${HIDDEN}`],
      ["{\"log\":\"Errore\\u001b[/home/anna rossi/x\"}", `{"log":"Errore\\u001b[${HIDDEN}"}`],
    ]);
    // Nor the letter of a drive.
    expectHidden("C:\\Users\\Anna Rossi", [
      ["Errore \u001b[C:\\Users\\Anna Rossi\\x", `Errore \u001b[${HIDDEN}`],
      ["Errore\u001bC:\\Users\\Anna Rossi\\x", `Errore\u001b${HIDDEN}`],
      ["Errore\u001b[1C:/Users/Anna Rossi/x", `Errore\u001b[1${HIDDEN}`],
    ]);
  });

  it("una sequenza tolta è un confine, mai una colla: colore attaccato, ESC 7 e ESC 8, ^[ di cat -v, ␛, \\x1b (S8-confine)", () => {
    // Before: the word before the sequence was glued to the path, and the whole home went out.
    expectHidden("/home/anna rossi", [
      ["Errore\u001b[31m/home/anna rossi/x", `Errore\u001b[31m${HIDDEN}`],
      ["\u001b7/home/anna rossi/x\u001b8", `\u001b7${HIDDEN}\u001b8`],
      ["Errore ^[[31m/home/anna rossi/x", `Errore ^[[31m${HIDDEN}`],
      ["Errore^[[31m/home/anna rossi/x", `Errore^[[31m${HIDDEN}`],
      ["Errore ␛[31m/home/anna rossi/x", `Errore ␛[31m${HIDDEN}`],
      ["ErroreM-^[31m/home/anna rossi/x", `ErroreM-^[31m${HIDDEN}`],
      ["Errore\u009b1m/home/anna rossi/x", `Errore\u009b1m${HIDDEN}`],
      ["Errore\u001b(B/home/anna rossi/x", `Errore\u001b(B${HIDDEN}`],
      ["Errore \\x1b[31m/home/anna rossi/x", `Errore \\x1b[31m${HIDDEN}`],
      ["Errore \\x2fhome\\x2fanna rossi", `Errore ${HIDDEN}`],
      ["{\"log\":\"Errore\\u001b[31m/home/anna rossi/x\"}", `{"log":"Errore\\u001b[31m${HIDDEN}"}`],
      // A path that is no private folder too.
      ["warning:\u001b[1m/srv/app/x.js\u001b[0m: unused", `warning:\u001b[1m${HIDDEN}\u001b[0m: unused`],
    ]);
  });

  it("una sequenza dentro un percorso non lo taglia: la cartella privata resta intera", () => {
    expectHidden("/home/anna rossi", [
      ["Non leggo /home/\u001b[1manna rossi\u001b[0m/x", `Non leggo ${HIDDEN}`],
      ["cp \u001b[2m/home/anna rossi/\u001b[22m\u001b[1mx.ts\u001b[22m", `cp \u001b[2m${HIDDEN}\u001b[22m`],
    ]);
  });

  it("un indirizzo locale dopo una sequenza, o dopo «-», è un indirizzo locale (S8-indirizzo)", () => {
    // Before: "Errore" or "-" glued to the scheme, and the address was neither local nor a web one.
    expectHidden("/home/anna rossi", [
      ["Errore\u001b[31mfile:///home/anna%20rossi/x", `Errore\u001b[31mfile:${HIDDEN}`],
      ["Copia\u001b[0msftp://host/home/anna rossi/x", `Copia\u001b[0msftp://host${HIDDEN}`],
      ["Valore -file:///home/anna rossi/x", `Valore -file:${HIDDEN}`],
      ["Valore -^[[31mfile:///home/anna%20rossi/x", `Valore -^[[31mfile:${HIDDEN}`],
    ]);
  });

  it("il byte finale non prende la barra rovescia di un escape che una lettura decodifica (S8-escape)", () => {
    // Before: "\u009b1\" (a final byte "\") took the escape of "m", or "␛\" the shell escape of "[", and the path stayed
    // glued in every reading.
    expectHidden("/home/anna rossi", [
      ["{\"log\":\"Errore \u009b1\\u006d/home/anna rossi/x\"}", `{"log":"Errore \u009b1\\u006d${HIDDEN}"}`],
      ["Errore␛\\[31m/home/anna\\ rossi/x", `Errore␛\\[31m${HIDDEN}`],
      ["\u001b]8;;https://example.com/x\u001b\\/home/anna rossi/x\u001b]8;;\u001b\\", `\u001b]8;;https://example.com/x\u001b${HIDDEN}`],
    ]);
  });

  it("oltre tre decodifiche ogni cartella privata va via, comunque scritta (S8-oltre)", () => {
    // Before: past DECODINGS the whole home stayed (verify7 n5: JSON in JSON in JSON, letters as \uXXXX, "#" escaped
    // by a shell).
    const cases: Array<[home: string, text: string, words: string[]]> = [
      // Before: "#rossi" stayed (a shell escape in JSON in JSON in JSON: four decodings).
      ["/home/anna#rossi", nested(JSON.stringify({ log: "Errore: /home/anna\\#rossi/x" }), 2), ["anna", "rossi"]],
      // Before: "\u0061nn\u0061" stayed, the "anna" of the home.
      ["/home/anna#rossi", nested("...\\/home\\/anna\\#rossi\\/x", 3).replace(/[ae]/gu, (char) => `\\u00${char.charCodeAt(0).toString(16)}`), ["anna", "rossi"]],
      ["/home/anna rossi", nested("rsync: cannot open /home/anna\\ rossi/x: denied", 4), ["anna", "rossi"]],
      ["/home/anna rossi", nested("Errore:\\/home\\/anna rossi\\/x", 5), ["anna", "rossi"]],
      ["C:\\Users\\bob rossi", nested("Errore C:\\Users\\bob rossi\\x", 4), ["bob", "rossi"]],
      ["C:\\Users\\bob rossi", nested("Apri file:///C:/Users/bob%20rossi/x", 5), ["bob", "rossi"]],
    ];
    for (const [home, text, words] of cases) {
      withHome(home, () => {
        const hidden = flattened(hideFilePaths(text));
        for (const word of words) expect(hidden, `${text}\n→ ${hidden}`).not.toContain(word);
      });
    }
  });

  it("gli indirizzi dei siti restano con i colori e le sequenze; un link del sito con le barre di PHP va come senza", () => {
    withHome("/home/anna", () => {
      for (const url of ["https://example.com/data/x.png", "https://example.com/home/anna/x.png"]) {
        for (const text of [`\u001b[34m${url}\u001b[0m`, `\u001b7${url}\u001b8`, `^[[34m${url}^[[0m`, `Media ␛[4m${url}␛[0m (404).`]) {
          expect(hideFilePaths(text, undefined, ["/data"])).toBe(text);
        }
      }
      // A link of the site written by PHP reads as the absolute path it may be (a server's, "\/var\/www\/…"): it goes,
      // as it does unescaped (accepted, round 7).
      expect(hideFilePaths("{\"href\":\"\\/chi-siamo\\/team\\/\"}")).toBe(`{"href":"${HIDDEN}"}`);
      expect(hideFilePaths("{\"href\":\"/chi-siamo/team/\"}")).toBe(`{"href":"${HIDDEN}"}`);
      expect(hideFilePaths("{\"path\":\"\\/var\\/www\\/html\\/wp-config.php\"}")).toBe(`{"path":"${HIDDEN}"}`);
    });
  });

  it("i casi del verificatore del round 7 (S8)", () => {
    const groups: Array<[home: string, data: string | undefined, error: Record<string, string> | undefined, cases: Array<[string, string]>]> = [
      // n1
      ["/home/anna rossi", undefined, undefined, [
        ["Errore \u009b/home/anna rossi/x", "Errore \u009b[percorso rimosso]"],
        ["Errore \u001b(/home/anna rossi/x", "Errore \u001b([percorso rimosso]"],
        ["Errore \u001b[/home/anna rossi/x", "Errore \u001b[[percorso rimosso]"],
        ["Errore \u001b/home/anna rossi/x", "Errore \u001b[percorso rimosso]"],
        ["Errore \u001b[ /home/anna rossi/x", "Errore \u001b[ [percorso rimosso]"],
        ["{\"log\":\"Errore \\u001b[/home/anna rossi/x\"}", "{\"log\":\"Errore \\u001b[[percorso rimosso]\"}"],
        ["{\"log\":\"Errore \\u009b/home/anna rossi/x\"}", "{\"log\":\"Errore \\u009b[percorso rimosso]\"}"],
        ["Errore\u001b[31m/home/anna rossi/x", "Errore\u001b[31m[percorso rimosso]"],
        ["\u001b7/home/anna rossi/x\u001b8", "\u001b7[percorso rimosso]\u001b8"],
        ["cp \u001b[2m/home/anna rossi/\u001b[22m\u001b[1mx.ts\u001b[22m", "cp \u001b[2m[percorso rimosso]\u001b[22m"],
        ["\u001b]8;;https://example.com/x\u001b\\/home/anna rossi/x\u001b]8;;\u001b\\", "\u001b]8;;https://example.com/x\u001b[percorso rimosso]"],
        ["Errore \\x1b[31m/home/anna rossi/x", "Errore \\x1b[31m[percorso rimosso]"],
        ["Errore \\033[31m/home/anna rossi/x", "Errore \\033[31m[percorso rimosso]"],
        ["Errore \\e[31m/home/anna rossi/x", "Errore \\e[31m[percorso rimosso]"],
        ["Errore ^[[31m/home/anna rossi/x", "Errore ^[[31m[percorso rimosso]"],
        ["Errore ␛[31m/home/anna rossi/x", "Errore ␛[31m[percorso rimosso]"],
      ]],
      // p5
      ["/home/anna rossi", undefined, undefined, [
        ["Errore\u001b[31m/home/anna rossi/x", "Errore\u001b[31m[percorso rimosso]"],
        ["x.js\u001b[0m:\u001b[1m/home/anna rossi/x", "x.js\u001b[0m:\u001b[1m[percorso rimosso]"],
        ["\u001b[2K\u001b[1G/home/anna rossi/x", "\u001b[2K\u001b[1G[percorso rimosso]"],
        ["\u001b[?25l/home/anna rossi/x\u001b[?25h", "\u001b[?25l[percorso rimosso]\u001b[?25h"],
        ["\u001b]0;titolo\u0007/home/anna rossi/x", "\u001b]0;titolo\u0007[percorso rimosso]"],
        ["\u001b7/home/anna rossi/x\u001b8", "\u001b7[percorso rimosso]\u001b8"],
        ["\u001b[38;5;196m/home/anna rossi/x\u001b[0m", "\u001b[38;5;196m[percorso rimosso]\u001b[0m"],
        ["\u001b[38:2:255:0:0m/home/anna rossi/x\u001b[0m", "\u001b[38:2:255:0:0m[percorso rimosso]\u001b[0m"],
        ["\u001b[K/home/anna rossi/x", "\u001b[K[percorso rimosso]"],
        ["\u001b[1;31m\u001b(0/home/anna rossi/x", "\u001b[1;31m\u001b(0[percorso rimosso]"],
      ]],
      // n3
      ["/home/anna rossi", undefined, {"path":"/home"}, [
        ["EACCES: mkdir '/home' and '/home/anna rossi/x y'", "EACCES: mkdir '[percorso rimosso]' and '[percorso rimosso]'"],
      ]],
      // n3
      ["/home/anna rossi", undefined, {"path":"anna"}, [
        ["EACCES: mkdir 'anna' in /srv/x ui/home/anna rossi/x", "EACCES: mkdir '[percorso rimosso]' in [percorso rimosso] ui[percorso rimosso]"],
      ]],
      // n3
      ["/home/anna rossi", undefined, {"path":"/home/anna rossi/x y"}, [
        ["ENOENT: open '/home/anna rossi/x y' (\"\\/home\\/anna rossi\\/x y\")", "ENOENT: open '[percorso rimosso]' (\"[percorso rimosso]\")"],
      ]],
      // n3
      ["/home/c#dev", undefined, undefined, [
        ["Apri file:///home/c%23dev/Sito/x.html", "Apri file:[percorso rimosso]"],
        ["Apri http://localhost:4321/?file=%2Fhome%2Fc%23dev%2Fx", "Apri http://localhost:4321/?file=[percorso rimosso]"],
      ]],
      // n3
      ["/home/anna?x", undefined, undefined, [
        ["Apri file:///home/anna%3Fx/Sito/x.html", "Apri file:[percorso rimosso]"],
      ]],
      // n3
      ["/home/100%41", undefined, undefined, [
        ["Apri file:///home/100%2541/x", "Apri file:[percorso rimosso]"],
        ["Apri /home/100%41/x", "Apri [percorso rimosso]"],
      ]],
      // n3
      ["/home/anna", "/data", undefined, [
        ["{\"code\":\"rest_upload_sideload_error\",\"data\":{\"url\":\"https:\\/\\/example.com\\/data\\/x.png\"}}", "{\"code\":\"rest_upload_sideload_error\",\"data\":{\"url\":\"https:\\/\\/example.com\\/data\\/x.png\"}}"],
        ["\"\\\"{\\\\\\\"url\\\\\\\":\\\\\\\"https:\\\\\\\\/\\\\\\\\/example.com\\\\\\\\/data\\\\\\\\/x.png\\\\\\\"}\\\"\"", "\"\\\"{\\\\\\\"url\\\\\\\":\\\\\\\"https:\\\\\\\\/\\\\\\\\/example.com\\\\\\\\/data\\\\\\\\/x.png\\\\\\\"}\\\"\""],
        ["\"\\\"\\\\\\\"{\\\\\\\\\\\\\\\"url\\\\\\\\\\\\\\\":\\\\\\\\\\\\\\\"https:\\\\\\\\\\\\\\\\/\\\\\\\\\\\\\\\\/example.com\\\\\\\\\\\\\\\\/data\\\\\\\\\\\\\\\\/x.png\\\\\\\\\\\\\\\"}\\\\\\\"\\\"\"", "\"\\\"[percorso rimosso]\"{\\\\[percorso rimosso]\\\\\\\":\\\\[percorso rimosso]\\\\\\\"}\\\\\\\"\\\"\""],
        ["Non leggo /srv/x ui/data/card e https://example.com/data/x.png", "Non leggo [percorso rimosso] e https://example.com/data/x.png"],
        ["{\"href\":\"\\/chi-siamo\\/team\\/\"}", "{\"href\":\"[percorso rimosso]\"}"],
        ["{\"link\":\"https:\\/\\/example.com\\/data\\/\"}", "{\"link\":\"https:\\/\\/example.com\\/data\\/\"}"],
        ["Vedi https://example.com/data/x e /srv/a/b", "Vedi https://example.com/data/x e [percorso rimosso]"],
      ]],
      // n4
      ["/home/anna rossi", undefined, undefined, [
        ["\"\\\"\\\\\\\"rsync: cannot open /home/anna\\\\\\\\\\\\\\\\ rossi/x: denied\\\\\\\"\\\"\"", "\"\\\"[percorso rimosso]\"\\\"\""],
        ["\"\\\"rsync: cannot open /home/anna\\\\\\\\ rossi/x: denied\\\"\"", "\"\\\"rsync: cannot open [percorso rimosso]: denied\\\"\""],
        ["\"\\\"\\\\\\\"{\\\\\\\\\\\\\\\"msg\\\\\\\\\\\\\\\":\\\\\\\\\\\\\\\"Errore:\\\\\\\\\\\\\\\\/home\\\\\\\\\\\\\\\\/anna rossi\\\\\\\\\\\\\\\\/x\\\\\\\\\\\\\\\"}\\\\\\\"\\\"\"", "\"\\\"[percorso rimosso]\"{\\\\[percorso rimosso]\\\\\\\":\\\\[percorso rimosso]\\\\\\\"}\\\\\\\"\\\"\""],
        ["\"\\\"{\\\\\\\"msg\\\\\\\":\\\\\\\"Errore:\\\\\\\\/home\\\\\\\\/anna rossi\\\\\\\\/x\\\\\\\"}\\\"\"", "\"\\\"{\\\\\\\"msg\\\\\\\":\\\\\\\"Errore:[percorso rimosso]\\\\\\\"}\\\"\""],
        ["\"\\\"\\\\\\\"\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\\u001b[31m/home/anna rossi/x\\\\\\\\\\\\\\\\u001b[0m\\\\\\\\\\\\\\\"\\\\\\\"\\\"\"", "\"\\\"[percorso rimosso]\"[percorso rimosso]\\\"[percorso rimosso]\"\\\\\\\"\\\"\""],
        ["\"\\\"\\\\\\\"\\\\\\\\u001b[31m/home/anna rossi/x\\\\\\\\u001b[0m\\\\\\\"\\\"\"", "\"\\\"[percorso rimosso]\"[percorso rimosso]\\\"\\\"\""],
      ]],
      // n5
      ["/home/8ACqxz#xvkj-nbnjxv", undefined, undefined, [
        ["[\"Valo\\u0072e {\\\"lo\\u0067\\\":\\\"V\\u0061\\u006co\\u0072e {\\\\\\\"log\\\\\\\":\\\\\\\"...\\/hom\\u0065\\/8ACq\\u0078\\u007a\\\\\\\\\\\\\\\\#xv\\u006b\\u006a-nbnjxv\\/rrzqk\\/8\\u007aqk\\\\\\\"} \\u0072if\\u0069\\u0075tato.\\\"} rifiutato.\"]", "[\"Valo\\u0072e {\\\"lo\\u0067\\\":\\\"V\\u0061\\u006co\\u0072e {\\\\\\\"log\\\\\\\":\\\\\\\"...[percorso rimosso]\\\\\\\"} \\u0072if\\u0069\\u0075tato.\\\"} rifiutato.\"]"],
      ]],
      // n5
      ["/Users/uzqk@bzqk", "/srv/utvkj%Nnnqxz(1zqk", undefined, [
        ["Valore {\"log\":\"{\\\"msg\\\":\\\"Valore {\\\\\\\"log\\\\\\\":\\\\\\\"Valore -d\\/Users\\/uzqk\\\\\\\\\\\\\\\\@bzqk\\/fqxz'\\\\\\\"} rifiutato.\\\"}\"} rifiutato.", "Valore {\"log\":\"{\\\"msg\\\":\\\"Valore {\\\\\\\"log\\\\\\\":\\\\\\\"Valore -d[percorso rimosso]'\\\\\\\"} rifiutato.\\\"}\"} rifiutato."],
      ]],
      // n5
      ["/home/Ab8vkj]rb0wzq", undefined, undefined, [
        ["[\"[\\\"Valore {\\\\\\\"log\\\\\\\":\\\\\\\"-\\\\\\\\/home\\\\\\\\/Ab8vkj\\\\\\\\\\\\\\\\]rb0wzq\\\\\\\"} rifiutato.\\\"]\"]", "[\"[\\\"Valore {\\\\\\\"log\\\\\\\":\\\\\\\"-[percorso rimosso]\\\\\\\"} rifiutato.\\\"]\"]"],
      ]],
      // p1
      ["/home/anna rossi", undefined, undefined, [
        ["\u001b/home/anna rossi/x", "\u001b[percorso rimosso]"],
        ["\u001b(/home/anna rossi/x", "\u001b([percorso rimosso]"],
        ["\u001b[ /home/anna rossi/x", "\u001b[ [percorso rimosso]"],
        ["\u001b[31 /home/anna rossi/x", "\u001b[31 [percorso rimosso]"],
        ["Errore: \u001b[/home/anna rossi/x", "Errore: \u001b[[percorso rimosso]"],
        ["\u009b /home/anna rossi/x", "\u009b [percorso rimosso]"],
        ["Errore \u009b/home/anna rossi/x", "Errore \u009b[percorso rimosso]"],
        ["\u001b[1m\u001b(B/home/anna rossi/x", "\u001b[1m\u001b(B[percorso rimosso]"],
        ["\u001b]8;;file://pc/home/anna%20rossi/x.ts\u001b\\x.ts\u001b]8;;\u001b\\", "\u001b]8;;file://pc[percorso rimosso]"],
        ["{\"msg\":\"Errore \\u002fhome\\u002fanna rossi\\u002fx\"}", "{\"msg\":\"Errore [percorso rimosso]\"}"],
        ["Errore \\x2fhome\\x2fanna rossi", "Errore [percorso rimosso]"],
        ["Errore '[percorso rimosso]' e 'parole dopo' fine", "Errore '[percorso rimosso]' e 'parole dopo' fine"],
        ["Non leggo [percorso rimosso] di Anna/x.html", "Non leggo [percorso rimosso] di Anna/x.html"],
        ["lstat '[percorso rimosso]/anna rossi/x y' e poi 'altro'", "lstat '[percorso rimosso]' e poi 'altro'"],
        ["Usa \\n per andare a capo e \\t per il tab", "Usa \\n per andare a capo e \\t per il tab"],
        ["Il selettore \\\"a > b\\\" non vale", "Il selettore \\\"a > b\\\" non vale"],
        ["Valore {\"css\":\"url(\\\"/img/a.png\\\")\"} rifiutato.", "Valore {\"css\":\"url(\\\"[percorso rimosso]\")\"} rifiutato."],
        ["Il campo \\\"titolo\\\" è vuoto: scrivi qualcosa", "Il campo \\\"titolo\\\" è vuoto: scrivi qualcosa"],
        ["La regex ^\\/blog\\/(.*)$ non vale", "La regex ^[percorso rimosso] non vale"],
        ["{\"message\":\"Sorry, you are not allowed to edit this post.\",\"data\":{\"status\":403}}", "{\"message\":\"Sorry, you are not allowed to edit this post.\",\"data\":{\"status\":403}}"],
        ["{\"code\":\"rest_invalid_param\",\"message\":\"Invalid parameter(s): slug\",\"data\":{\"status\":400,\"params\":{\"slug\":\"slug non valido\"}}}", "{\"code\":\"rest_invalid_param\",\"message\":\"Invalid parameter(s): slug\",\"data\":{\"status\":400,\"params\":{\"slug\":\"slug non valido\"}}}"],
        ["{\"code\":\"x\",\"message\":\"Il file \\u00e8 troppo grande (max 2 MB)\"}", "{\"code\":\"x\",\"message\":\"Il file \\u00e8 troppo grande (max 2 MB)\"}"],
        ["Vedi http://localhost:8080/wp-admin/admin.php?page=x&redirect=%2Fwp-admin%2Fedit.php", "Vedi http://localhost:8080/wp-admin/admin.php?page=x&redirect=[percorso rimosso]"],
        ["Vedi http://localhost:8080/?q=%22ciao%22&r=%2F", "Vedi http://localhost:8080/?q=%22ciao%22&r=%2F"],
        ["Media https:\\/\\/example.com\\/wp-content\\/uploads\\/2024\\/01\\/x.png (404).", "Media https:\\/\\/example.com\\/wp-content\\/uploads\\/2024\\/01\\/x.png (404)."],
        ["Media https://example.com/wp-content/uploads/2024/01/x.png (404).", "Media https://example.com/wp-content/uploads/2024/01/x.png (404)."],
        ["npm ERR! \u001b[31mcode\u001b[39m E404 https://registry.npmjs.org/x", "npm ERR! \u001b[31mcode\u001b[39m E404 https://registry.npmjs.org/x"],
        ["warning: \u001b[1m/srv/app/x.js\u001b[0m: unused", "warning: \u001b[1m[percorso rimosso]\u001b[0m: unused"],
        ["Scrivi C:\\\\ oppure D:\\\\", "Scrivi [percorso rimosso] oppure [percorso rimosso]"],
        ["a\\\\b e c\\\\d", "a\\\\b e c\\\\d"],
        ["{\"path\":\"\\/var\\/www\\/html\\/wp-content\\/uploads\"}", "{\"path\":\"[percorso rimosso]\"}"],
        ["Errore 50% \\% fatto", "Errore 50% \\% fatto"],
        ["La pagina \\\"Chi siamo\\\" usa lo slug \\\"chi-siamo\\\"", "La pagina \\\"Chi siamo\\\" usa lo slug \\\"chi-siamo\\\""],
        ["Il prototipo usa 'https://example.com/a b' e 'altro'", "Il prototipo usa 'https://example.com/a b' e 'altro'"],
      ]],
      // p1
      ["/home/anna", "/data", undefined, [
        ["Media https://example.com/data/x.png\\nfile:///data/y (404).", "Media https://example.com/data/x.png\\nfile:[percorso rimosso] (404)."],
        ["{\"url\":\"https:\\\\/\\\\/example.com\\\\/data\\\\/x.png\"}", "{\"url\":\"https:\\\\/\\\\/example.com\\\\/data\\\\/x.png\"}"],
        ["{\"url\":\"https:\\\\\\/\\\\\\/example.com\\\\\\/data\\\\\\/x.png\"}", "{\"url\":\"https:\\\\\\/\\\\\\/example.com\\\\\\/data\\\\\\/x.png\"}"],
        ["{\"msg\":\"{\\\"url\\\":\\\"https:\\\\\\/\\\\\\/example.com\\\\\\/data\\\\\\/x.png\\\"}\"}", "{\"msg\":\"{\\\"url\\\":\\\"https:\\\\\\/\\\\\\/example.com\\\\\\/data\\\\\\/x.png\\\"}\"}"],
        ["Media https://example.com/data/x.png?ver=1\\u0026a=/data/b (404).", "Media https://example.com/data/x.png?ver=1\\u0026a=[percorso rimosso] (404)."],
        ["Media \\\"https://example.com/data/x.png\\\" (404).", "Media \\\"https://example.com/data/x.png\\\" (404)."],
        ["Media 'https://example.com/data/x.png' (404).", "Media 'https://example.com/data/x.png' (404)."],
        ["Media `https://example.com/data/x.png` (404).", "Media `https://example.com/data/x.png` (404)."],
        ["Media https://example.com/data%20x/data/x.png (404).", "Media https://example.com/data%20x/data/x.png (404)."],
        ["Media https://example.com/a%2Fdata/x.png (404).", "Media https://example.com/a%2Fdata/x.png (404)."],
        ["Vedi https://example.com/x\\ny /data/x.png", "Vedi https://example.com/x\\ny [percorso rimosso]"],
        ["Il CSS url(/data/x.png) non trovato", "Il CSS url([percorso rimosso]) non trovato"],
        ["Media https://example.com/\\u0064ata/x.png (404).", "Media https://example.com/\\u0064ata/x.png (404)."],
        ["Errore https://example.com/data/x.png\\u001b[0m", "Errore https://example.com/data/x.png\\u001b[0m"],
        ["Errore \u001b[4mhttps://example.com/data/x.png\u001b[0m", "Errore \u001b[4mhttps://example.com/data/x.png\u001b[0m"],
        ["Errore https://cdn.example.com/data/x.png e https://example.com/data/y.png", "Errore https://cdn.example.com/data/x.png e https://example.com/data/y.png"],
        ["Media http://example.localhost/data/x.png (404).", "Media http://example.localhost[percorso rimosso] (404)."],
        ["Media https://sito-di-prova.local/data/x.png (404).", "Media https://sito-di-prova.local/data/x.png (404)."],
        ["Media https://sito-di-prova.local/wp-content/uploads/data/x.png (404).", "Media https://sito-di-prova.local/wp-content/uploads/data/x.png (404)."],
      ]],
      // p1
      ["C:\\Users\\nadia", undefined, undefined, [
        ["riga\\nC:\\Users\\nadia\\x", "riga\\n[percorso rimosso]"],
        ["ENOENT: no such file or directory, open 'C:\\Users\\nadia\\Sito\\x.html'", "ENOENT: no such file or directory, open '[percorso rimosso]'"],
        ["{\"msg\":\"ENOENT: open 'C:\\\\Users\\\\nadia\\\\Sito\\\\x.html'\"}", "{\"msg\":\"ENOENT: open '[percorso rimosso]'\"}"],
        ["{\"msg\":\"{\\\"p\\\":\\\"C:\\\\\\\\Users\\\\\\\\nadia\\\\\\\\x\\\"}\"}", "{\"msg\":\"{\\\"p\\\":\\\"[percorso rimosso]\"}\"}"],
        ["Errore C:/Users/nadia/x", "Errore [percorso rimosso]"],
        ["Errore file:///C:/Users/nadia/x", "Errore file:///[percorso rimosso]"],
        ["Errore \\\\?\\C:\\Users\\nadia\\x", "Errore [percorso rimosso]"],
        ["Errore \u001b[31mC:\\Users\\nadia\\x\u001b[0m", "Errore \u001b[31m[percorso rimosso]\u001b[0m"],
        ["Errore C:\\Users\\nadia\\#progetti\\x", "Errore [percorso rimosso]"],
        ["Errore C:\\Users\\nadia\\ x", "Errore [percorso rimosso] x"],
        ["Errore C:\\Users\\nadia\\%20x", "Errore [percorso rimosso]"],
      ]],
      // p3
      ["/home/anna rossi", undefined, undefined, [
        ["error: \u001b]8;;file://pc/home/anna%20rossi/Sito/x.ts\u001b\\/home/anna rossi/Sito/x.ts\u001b]8;;\u001b\\: boom", "error: \u001b]8;;file://pc[percorso rimosso]: boom"],
        ["error: \u001b]8;;file://pc/srv/app/x.ts\u001b\\/srv/app/x.ts\u001b]8;;\u001b\\: boom", "error: \u001b]8;;file://pc/srv/app/x.ts\u001b[percorso rimosso];;\u001b\\: boom"],
        ["error: \u001b]8;;file://pc/srv/app/x.ts\u001b\\x.ts\u001b]8;;\u001b\\: boom", "error: \u001b]8;;file://pc/srv/app/x.ts\u001b\\x.ts\u001b]8;;\u001b\\: boom"],
        ["error: \u001b\\/srv/app/x.ts", "error: \u001b[percorso rimosso]"],
        ["Errore \u001b/srv/app/x.ts", "Errore \u001b[percorso rimosso]"],
        ["Errore \u001b(/srv/app/x.ts", "Errore \u001b([percorso rimosso]"],
        ["Errore \u009b/srv/app/x.ts", "Errore \u009b[percorso rimosso]"],
        ["Errore \u001b[ /srv/app/x.ts", "Errore \u001b[ [percorso rimosso]"],
      ]],
    ];
    for (const [home, data, error, cases] of groups) {
      withHome(home, () => {
        for (const [text, hidden] of cases) {
          expect(hideFilePaths(text, error ? Object.assign(new Error("x"), error) : undefined, data ? [data] : []), JSON.stringify(text)).toBe(hidden);
        }
      });
    }
  });

  it("non lascia la home con sequenze del terminale e decodifiche annidate fino a cinque livelli (S8, fuzz)", () => {
    // A fixed seed (xorshift): a failure is the same on every run.
    let seed = 0x51ed2701;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const markers = ["qxz", "vkj", "wzq", "jxv", "zqk", "xjw"];
    const letters = [..."nnttrrbbffuuabcdeghilmopsvABCDEFNTRU0123456789"];
    const word = (words: string[]) => {
      const made = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(letters)).join("") + pick(markers) + Array.from({ length: Math.floor(random() * 3) }, () => pick(letters)).join("");
      words.push(made);
      return made;
    };
    const joints = [" ", "'", ".", "&", "+", "=", "@", "%", "~", "[", "]", "#", "$", "!", "-", "_"];
    const folderName = (words: string[]) => {
      let made = word(words);
      for (let count = Math.floor(random() * 3); count > 0; count -= 1) made += pick(joints) + word(words);
      return made;
    };
    const shellEscaped = (path: string) => path.replace(/([ '"()&;!$#[\]{}^~`,=+@%*?<>|\\])/gu, "\\$1");
    // Some letters as "\uXXXX", never inside an escape.
    const unicodeLetters = (text: string) => text.replace(/\\u[0-9a-fA-F]{4}|\\.|[a-z]/gu, (part) => (part.length === 1 && random() < 0.3 ? `\\u00${part.charCodeAt(0).toString(16)}` : part));
    const sequences = ["\u001b[31m", "\u001b[0m", "\u001b7", "\u001b8", "\u001b(B", "\u001b[2K\u001b[1G", "\u009b1m", "^[[31m", "␛[31m", "\u001b[?25l", "\u001b[38;5;196m", "\u001b", "\u001b[", "\u009b", "\u001b(", "\u001b[1"];
    let checked = 0;
    for (let round = 0; round < 1500; round += 1) {
      const windows = random() < 0.25;
      const separator = windows ? "\\" : "/";
      const secret: string[] = [];
      const home = windows ? `C:\\Users\\${folderName(secret)}` : `${pick(["/home", "/Users"])}/${folderName(secret)}`;
      const named: string[] = [];
      const full = `${home}${separator}${Array.from({ length: 1 + Math.floor(random() * 2) }, () => word(named)).join(separator)}${pick(["", ".html"])}`;
      const slashed = full.replaceAll("\\", "/");
      const url = windows ? `file:///${encodeURI(slashed)}` : pathToFileURL(full).href;
      const lead = pick(["", "Errore", "Errore ", "Errore: ", "x.js", "riga 1", "-", "(", "cp "]);
      const sequence = () => pick(sequences);
      let text = pick([
        `${lead}${sequence()}${full}`,
        `${lead}${sequence()}${full}${sequence()}`,
        `${lead}${sequence()}${sequence()}${full}`,
        `${lead}\n${full}`,
        `${lead}\t${url}`,
        `${lead}:${slashed}`,
        windows ? `${lead} ${full}` : `${lead} ${shellEscaped(full)}`,
        `${lead}${sequence()}${url}`,
      ]);
      const levels = Math.floor(random() * 6);
      for (let level = 0; level < levels; level += 1) {
        text = JSON.stringify(random() < 0.5 ? { log: text } : text);
        if (random() < 0.4) text = text.replaceAll("/", "\\/");
        if (random() < 0.3) text = unicodeLetters(text);
        if (!windows && random() < 0.15) text = shellEscaped(text);
      }
      text = `Valore ${text} rifiutato.`;
      withHome(home, () => {
        const hidden = hideFilePaths(text);
        const context = `HOME=${home}\nIN : ${JSON.stringify(text)}\nOUT: ${JSON.stringify(hidden)}`;
        expect(hidden, context).not.toContain("\uE000");
        const flat = flattened(hidden);
        for (const name of secret) expect(flat, `${context}\nleft: ${name}`).not.toContain(name.toLowerCase());
        checked += 1;
      });
    }
    expect(checked).toBe(1500);
  }, 60_000);
});

describe("percorsi nei messaggi per l'agente: indirizzi locali in tempo lineare, byte finali, colori negli indirizzi (S9)", () => {
  it("un indirizzo locale si legge in tempo lineare anche in una lunga fila di «-», «.» o «+» (S9-lineare)", () => {
    // Before (round 8): a local address could start after each "-", "." or "+" of the run and read the rest of it from
    // there, and each of these took 70–500 ms (2–15 ms each now; LOCAL_ADDRESS on 1 MiB of the run: about 20 ms).
    withHome("/home/anna rossi", () => {
      const started = performance.now();
      for (const glue of ["-", ".", "+"]) {
        hideFilePaths(`a${glue}`.repeat(2000) + "\\u005c" + "u005c".repeat(19) + "n");
        hideFilePaths(`a${glue}`.repeat(1900) + "\\".repeat(256) + "n");
        hideFilePaths(JSON.stringify(`a${glue}`.repeat(2040) + "\\"));
      }
      expect(performance.now() - started).toBeLessThan(1000);
    });
    // Read from the last part of its scheme, an address is found as before, and also with a digit after the "-".
    expectHidden("/home/anna rossi", [
      ["Valore x-2:///home/anna rossi/x", `Valore x-2:${HIDDEN}`],
      ["Valore -1:///home/anna rossi/x", `Valore -1:${HIDDEN}`],
      ["svn+ssh://host/home/anna rossi/x", `svn+ssh://host${HIDDEN}`],
      ["a.b.c-file:///home/anna%20rossi/x", `a.b.c-file:${HIDDEN}`],
      ["Vedi git+file:///home/anna%20rossi/x", `Vedi git+file:${HIDDEN}`],
      ["Valore -file:///home/anna rossi/x", `Valore -file:${HIDDEN}`],
      ["webpack-internal:///home/anna rossi/x.js", `webpack-internal:${HIDDEN}`],
    ]);
  });

  it("un byte finale può essere la prima lettera di un indirizzo: una lettura lo toglie, una lo tiene (S9-finale)", () => {
    // Before (round 8): the escape took the first letter of the scheme ("\u001b s"), the decoded reading was
    // "ftp://host/home/…", a web address, and the as-written one glued the scheme to the "b" of "\u001b".
    const addresses = ["sftp://host", "scp://host", "smb://host", "ssh://host", "file://server"];
    expectHidden("/home/anna rossi", addresses.flatMap((address): Array<[string, string]> => [
      [`{"m":"Copia \\u001b${address}/home/anna rossi/x"}`, `{"m":"Copia \\u001b${address}${HIDDEN}"}`],
      [`Copia \u001b${address}/home/anna rossi/x`, `Copia \u001b${address}${HIDDEN}`],
      // RIS ("\u001bc") before the address: the final byte is not the address's.
      [`Copia \u001bc${address}/home/anna rossi/x`, `Copia \u001bc${address}${HIDDEN}`],
      // The "[" or the "(" of the sequence written by an escape: as written, the scheme is glued to its last digit.
      [`{"m":"Copia \\u001b\\u005b${address}/home/anna rossi/x"}`, `{"m":"Copia \\u001b\\u005b${address}${HIDDEN}"}`],
      [`{"m":"Copia \\u001b\\u0028${address}/home/anna rossi/x"}`, `{"m":"Copia \\u001b\\u0028${address}${HIDDEN}"}`],
    ]));
    withHome("/home/anna rossi", () => {
      for (const address of addresses) {
        const hidden = flattened(hideFilePaths(nested(`Copia \u001b${address}/home/anna rossi/x`, 3)));
        expect(hidden, address).not.toContain("anna");
        expect(hidden, address).not.toContain("rossi");
      }
    });
    // ESC 7, ESC 8, ESC =, ESC > (0x30–0x3F) go, and a final byte kept ends no path that goes on after it.
    expectHidden("/home/anna rossi", [
      ["Errore\u001b=/home/anna rossi/x", `Errore\u001b=${HIDDEN}`],
      ["Errore\u001b>/home/anna rossi/x", `Errore\u001b>${HIDDEN}`],
      ["Errore\u001b7/home/anna rossi/x\u001b8 fine", `Errore\u001b7${HIDDEN}\u001b8 fine`],
      ["Non leggo /home/\u001bManna rossi/x", `Non leggo ${HIDDEN}`],
      ["Non leggo /home/\u001b[1manna rossi\u001b[0m/x", `Non leggo ${HIDDEN}`],
    ]);
  });

  it("un colore dentro un indirizzo non fa cominciare un percorso che senza colori non c'è (S9-colori)", () => {
    // Before (round 8): the boundary a colour left started a path anywhere, and the base path of a development
    // server's address or the rest of a link went.
    withHome("/home/anna", () => {
      for (const text of [
        "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m4321\u001b[22m/chi-siamo/\u001b[39m",
        "Vite \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
        "see https://x.org/a\u001b[0m/b/c",
        "\u001b[1mhttps://example.com/data/x.png\u001b[0m",
      ]) expect(hideFilePaths(text, undefined, ["/data"])).toBe(text);
    });
    // A private folder there still goes, as does a path a colour cuts from a word outside an address.
    expectHidden("/home/anna rossi", [
      ["http://localhost:\u001b[1m4321\u001b[22m/home/anna rossi/x", `http://localhost:\u001b[1m4321\u001b[22m${HIDDEN}`],
      ["https://x.org/a\u001b[0m/home/anna rossi/x", `https://x.org/a\u001b[0m${HIDDEN}`],
      ["Errore\u001b[31m/srv/app/x.js", `Errore\u001b[31m${HIDDEN}`],
      ["http://localhost:4321\u001b[0m /srv/app/x.js", `http://localhost:4321\u001b[0m ${HIDDEN}`],
    ]);
  });
});

describe("percorsi nei messaggi per l'agente: una sequenza non fa di un indirizzo locale uno web né nasconde un disco (S10)", () => {
  it("una sequenza fra la lettera di un disco e i suoi «:» non lascia la cartella Windows, in un indirizzo o no (S10-disco)", () => {
    // Before: no reading joins "C" to ":\Users\…", and inside a web or local address the boundary started no path.
    expectHidden("C:\\Users\\anna rossi", [
      ["file:///C\u001b[1m:/Users/anna rossi/x", `file:///C\u001b[1m:${HIDDEN}`],
      ["see http://localhost:3000/C\u001b[0m:/Users/anna rossi/x", `see http://localhost:3000/C\u001b[0m:${HIDDEN}`],
      ["Copia smb://srv/share/C\u001b[1m:\\Users\\anna rossi\\p", `Copia smb://srv/share/C\u001b[1m:${HIDDEN}`],
      ['{"m":"https://x.org/a/C\\u001b[1m:/Users/anna rossi/x"}', `{"m":"https://x.org/a/C\\u001b[1m:${HIDDEN}"}`],
      ['{"m":"vscode://file/C\\u009b0m:/Users/anna rossi/x"}', `{"m":"vscode://file/C\\u009b0m:${HIDDEN}"}`],
      // An escape and "\\" (ST) or a CSI with no final byte, which no reading takes out whole.
      ["see file:/a/C\u001b\\:/Users/anna rossi/x", `see file:/a/C\u001b\\:${HIDDEN}`],
      ["http://app.localhost:3000:/C\u241b[:/Users/anna rossi/x", `http://app.localhost:3000:/C\u241b[:${HIDDEN}`],
      ["Copia C\u001b[:\\Users\\anna rossi\\x.png fine", `Copia C\u001b[:${HIDDEN} fine`],
    ]);
    // Without its drive, the folder is the one on the same drive; one inside a site's path still stays (S3).
    expectHidden("C:\\Users\\anna rossi", [
      ["Non leggo \\Users\\anna rossi\\x", `Non leggo ${HIDDEN}`],
      ["https://x.org/Users/anna rossi/x", "https://x.org/Users/anna rossi/x"],
    ]);
  });

  it("una sequenza nello schema, nell'host o nella porta di un indirizzo web ne fa leggere il percorso come locale (S10-locale)", () => {
    // Before: every reading saw a web address, whose path belongs to the site, so the home after a part stayed.
    expectHidden("/home/anna rossi", [
      ["http://localhost:51\u009b73/x/home/anna rossi/y", `http://localhost:51\u009b73/x${HIDDEN}`],
      ["http://127.0.0.\u001b[1:8080/a/home/anna rossi/y", `http://127.0.0.\u001b[1:8080/a${HIDDEN}`],
      ["s\u001b[cp://user@host@/home/anna rossi/y", `s\u001b[cp://user@host@${HIDDEN}`],
      ['{"m":"s\\u001b[cp://h/a/home/anna rossi/y"}', `{"m":"s\\u001b[cp://h/a${HIDDEN}"}`],
    ]);
    // Only private folders go there: a colour in a web address, or anywhere in a local one, starts no path.
    withHome("/home/anna", () => {
      for (const text of [
        "see https://x.org/a\u001b[0m/b/c",
        "\u009b1mhttps://x.org/a\u009b0m/b/c",
        "https://x.org/chi-siamo\u001b[2m/team/",
        "https://x.org\u001b[0m/a/b",
        "http://localhost:3000\u001b[39m/wp-admin/",
        "http://localhost:\u001b[1m4321\u001b[22m/chi-siamo/",
        "  \u279c  Network: http://192.168.1.5:\u001b[1m5173\u001b[22m/base/",
      ]) expect(hideFilePaths(text)).toBe(text);
    });
  });
});
