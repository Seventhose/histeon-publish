import path from "node:path";
import type { Finding } from "./types.js";

const MAX_TEXT_SCAN_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".css", ".html", ".htm", ".js", ".mjs", ".json", ".txt", ".svg", ".xml", ".map"]);
const BLOCKED_NAMES = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/iu,
  /(?:^|\/)\.git(?:\/|$)/iu,
  /(?:^|\/)\.htaccess$/iu,
  /(?:^|\/)\.user\.ini$/iu,
  /(?:^|\/)wp-config(?:-[^/]*)?\.php$/iu,
  /\.(?:sql|bak|log)$/iu,
];
// Server-side code on PHP, CGI, SSI, ASP.NET, ColdFusion or JSP hosts (FTP/SFTP targets). Apache's AddHandler
// matches a PHP extension anywhere in the name ("x.php.jpg"), and Windows drops trailing dots and spaces ("x.php.").
const EXECUTABLE_FINAL = /^(?:php[0-9]?|phtml|phar|pht|phps|pgif|shtml|shtm|stm|cgi|fcgi|asp|aspx|ashx|asmx|ascx|asa|axd|cfm|cfml|cfc|jsp|jspx|jsf)$/iu;
const EXECUTABLE_INNER = /^(?:php[0-9]?|phtml|phar|pht|phps)$/iu;
const SERVER_CONFIG = /^(?:web\.config|\.htpasswd|\.htaccess|\.user\.ini|php\.ini|\.htdigest)$/iu;

/** True when a bundle path would run as code, or reconfigure the server, on a classic web host. */
export function isServerExecutablePath(relativePath: string): boolean {
  const segments = relativePath.split("/").map((segment) => segment.replace(/[.\s]+$/u, ""));
  if (segments.slice(0, -1).some((segment) => /^cgi-bin$/iu.test(segment))) return true;
  const name = segments.at(-1) ?? "";
  if (SERVER_CONFIG.test(name)) return true;
  const parts = name.split(".");
  if (parts.length < 2) return false;
  return EXECUTABLE_FINAL.test(parts.at(-1) ?? "") || parts.slice(1, -1).some((part) => EXECUTABLE_INNER.test(part));
}

const DYNAMIC_PATHS = [
  { code: "admin-link", pattern: /\/wp-admin\//iu, message: "Il contenuto include un collegamento all’amministrazione WordPress." },
  { code: "login-link", pattern: /wp-login\.php/iu, message: "Il contenuto include un collegamento al login WordPress." },
  { code: "wordpress-api-link", pattern: /\/wp-json\//iu, message: "Il contenuto fa riferimento all’API REST di WordPress." },
  { code: "wordpress-ajax-link", pattern: /admin-ajax\.php/iu, message: "Il contenuto fa riferimento a un endpoint AJAX di WordPress." },
];
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;
/** The prefixes of a service's secret key (Stripe, AWS, GitHub, Slack), each followed by 8 base64url characters at least. */
const SECRET_KEY_PREFIXES = ["sk_live_", "sk_test_", "rk_live_", "AKIA", "ghp_", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"];
/** Whether the character code is one of base64url's: a letter, a digit, `_` or `-`. */
function base64url(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x2d;
}

/** Where the base64url run that starts at `at` ends (`at` itself when none starts there). */
function base64urlEnd(text: string, at: number): number {
  let cursor = at;
  while (cursor < text.length && base64url(text.charCodeAt(cursor))) cursor += 1;
  return cursor;
}

/**
 * Where a service's secret key starts, or -1: a SECRET_KEY_PREFIXES prefix at a word boundary with 8 base64url
 * characters at least after it, as `\b(?:sk_live_|sk_test_|rk_live_|AKIA|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,}` finds
 * them. Read by hand, run by run: inside a base64url run a word boundary is only its start and after a `-`, and every
 * prefix lies inside the run, so each run is read once. The pattern threw a stack overflow on a run of 6 MiB after its
 * prefix (a long hex or base64url blob).
 */
function secretKeyIndex(text: string): number {
  let start = 0;
  while (start < text.length) {
    if (!base64url(text.charCodeAt(start))) {
      start += 1;
      continue;
    }
    const end = base64urlEnd(text, start);
    for (let at = start; at < end; at += 1) {
      if (at > start && text.charCodeAt(at - 1) !== 0x2d) continue;
      for (const prefix of SECRET_KEY_PREFIXES) if (end - at - prefix.length >= 8 && text.startsWith(prefix, at)) return at;
    }
    start = end;
  }
  return -1;
}

/**
 * Where a Google API key starts, or -1: `AIza` and 30 base64url characters at least, as `AIza[0-9A-Za-z_-]{30,}` finds
 * them (anywhere, with no word boundary). An `AIza` that falls short has every later one of its run shorter still, so
 * the search goes on after the run: each run is read once. The pattern threw a stack overflow on a run of 6 MiB.
 */
function googleKeyIndex(text: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf("AIza", from);
    if (at < 0) return -1;
    const end = base64urlEnd(text, at + 4);
    if (end - at - 4 >= 30) return at;
    from = end;
  }
}

/**
 * Where a JSON Web Token starts, or -1: `eyJ` (a base64url `{"`) at a word boundary, 20 characters at least to its dot,
 * then two dotted runs of 10 at least, as `\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` finds
 * them. Read by hand, run by run, each run at most three times (as the first, second and third of a token): the
 * pattern read a run again from each `-eyJ` inside it (100 KB of `eyJ-eyJ-…` took 4 s, a 20 MiB file hours), and the
 * pattern that then read each run from its start threw a stack overflow on a run of 5 MiB (a long hex blob).
 */
function jsonWebTokenIndex(text: string): number {
  // The next `-eyJ` at or after the run being read, found once for all the runs before it.
  let dash = -1;
  let start = 0;
  while (start < text.length) {
    if (!base64url(text.charCodeAt(start))) {
      start += 1;
      continue;
    }
    const end = base64urlEnd(text, start);
    // The leftmost `eyJ` at a word boundary: the run's start, or after a `-` (the run's only character that is no word's).
    let at = -1;
    if (text.startsWith("eyJ", start)) at = start;
    else {
      if (dash !== Number.POSITIVE_INFINITY && dash < start) {
        const found = text.indexOf("-eyJ", start);
        dash = found < 0 ? Number.POSITIVE_INFINITY : found;
      }
      if (dash + 4 <= end) at = dash + 1;
    }
    if (at >= 0 && end - at >= 23 && text[end] === ".") {
      const second = base64urlEnd(text, end + 1);
      if (second - (end + 1) >= 10 && text[second] === "." && base64urlEnd(text, second + 1) - (second + 1) >= 10) return at;
    }
    start = end;
  }
  return -1;
}
/**
 * The backslashes before an escaped slash or quote: one in JSON, three in JSON escaped once more, seven at most. Never
 * unbounded, so that a long run of backslashes costs each place of the text a few steps, not the whole run.
 */
const ESCAPES = String.raw`\\{0,7}`;
const ESCAPED = String.raw`\\{1,7}`;
/**
 * A folder of the server written in the content: a home (/home/<name>), a web root (/var/www/) or IIS's
 * (C:\inetpub\). Also with `\/` for each slash, as PHP's json_encode writes them into the data a WordPress page carries
 * inline (`\\\/` when that JSON is escaped once more), and with doubled backslashes as JSON writes a Windows path. The
 * first group is the start of an escaped home, which is one only when an account's name follows it (escapedHomeFolder).
 */
const SERVER_PATH = new RegExp(String.raw`(?:${ESCAPES}\/var${ESCAPES}\/www${ESCAPES}\/|\/home\/[^\s"'<>]|(${ESCAPED}\/home${ESCAPES}\/|\/home${ESCAPED}\/)|[A-Za-z]:${ESCAPED}inetpub${ESCAPED})`, "giu");
/**
 * How the account's name of an escaped home starts, after any `.` and `-` before it: a letter, a digit or `_`, or a
 * character written encoded: `\u00e8` (with the backslashes of JSON escaped once more), `%C3` (any byte) or a character
 * reference (`&#117;`, `&eacute;`; numeric ones only when they stand for a letter, a digit or `_`, named ones unless they
 * are NOT_NAME_REFERENCE).
 */
const NAME_START = /(?:[\p{L}\p{N}_]|%[\da-fA-F]{2}|\\{1,7}u[\da-fA-F]{4}|&(?:#(\d{1,7});?|#[xX]([\da-fA-F]{1,6});?|([A-Za-z][A-Za-z\d]{0,31});?))/uy;
const NAME_CHARACTER = /^[\p{L}\p{N}_]$/u;
/** The named references an escaped home is followed by when its JSON sits in HTML (`&quot;\/home\/&quot;`). */
const NOT_NAME_REFERENCE = /^(?:quot|apos|lt|gt|amp|nbsp)$/iu;
/**
 * The end of a string at the start of the text, or of the text itself: a quote, JSON-escaped too (`\"`, `\u0022`), or
 * written as a character reference (`&quot;`, `&#039;`).
 */
const STRING_END = /(?:\\{0,7}["']|\\{1,7}u00(?:22|27)|&(?:quot;|apos;|#0*3[49](?!\d);?|#[xX]0*2[27](?![\da-fA-F]);?)|$)/uy;
/** A regular expression literal's flags: some of d, g, i, m, s, u, v and y, each once. */
const REGEX_FLAGS = /^(?!.*(.).*\1)[dgimsuvy]{1,8}$/u;

/** The length of the character of an account's name written at `at` (NAME_START, as it decodes), 0 for none. */
function nameCharacter(text: string, at: number): number {
  NAME_START.lastIndex = at;
  const name = NAME_START.exec(text);
  if (!name) return 0;
  const [written, decimal, hex, reference] = name;
  if (reference !== undefined) return NOT_NAME_REFERENCE.test(reference) ? 0 : written.length;
  if (decimal === undefined && hex === undefined) return written.length;
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
  return code <= 0x10ffff && NAME_CHARACTER.test(String.fromCodePoint(code)) ? written.length : 0;
}

/**
 * Whether the escaped home whose name starts at `start` is a folder of the server: after the empty and `.` folders a
 * server skips (`\/home\/\/utente`, `\/home\/.\/utente`), its name starts as an account's does (NAME_START), whatever
 * follows. So `\/home\/utente\/index.php:12`, upload_dir's `\/home\/utente\/public_html\/…` and
 * `{&quot;u&quot;:&quot;\/home\/utente)&quot;}` are folders; `\/home\/.*`, `\/home\/-?\d+`, `\/home\/(\w+)` and
 * `\/home\/[a-z]+` are none. A script's regular expression that names a concrete account (`/^\/home\/user$/`,
 * `new RegExp("^\\/home\\/user$")`) is one too: it cannot be told from a folder by what follows it (round 8 tried, and
 * JSON quoted with `&quot;` read as a literal), so it blocks publishing and the script writes it another way
 * (`/^\/home\/[^/]+$/`).
 *
 * A plain `/` among the skipped folders (`\/home\//utente`, `\/home\/./utente`, mixed escaping no json_encode writes)
 * may instead close a literal (`/\/home\//g`, `/^\/home\//.test(p)`): after one, the name must be followed by a slash
 * or end a string (STRING_END), and a name that could be a literal's flags (REGEX_FLAGS) by a slash. So
 * `\/home\//utente\/public_html`, `\/home\//utente"`, `\/home\/./utente&quot;` and `\/home\//gi\/x` are folders;
 * `/\/home\//g,`, `<a data-re="/\/home\//gi">` and `/\/home\//.source;` are none. What this lets through is an
 * account written that way and followed by anything else (`\/home\//utente\n`, `\/home\//utente:12`), or named only
 * with flag letters and ending the string (`\/home\//gi"`).
 */
function escapedHomeFolder(text: string, start: number): boolean {
  let at = start;
  let plain = false;
  for (;;) {
    const dot = text[at] === "." ? 1 : 0;
    const skip = slash(text, at + dot);
    if (!skip) break;
    if (skip === 1) plain = true;
    at += dot + skip;
  }
  while (text[at] === "." || text[at] === "-") at += 1;
  if (!nameCharacter(text, at)) return false;
  if (!plain) return true;
  let end = at;
  for (;;) {
    STRING_END.lastIndex = end;
    if (end >= text.length || STRING_END.test(text) || slash(text, end)) break;
    const length = text[end] === "." || text[end] === "-" ? 1 : nameCharacter(text, end);
    if (!length) break;
    end += length;
  }
  if (slash(text, end)) return true;
  if (end - at <= 8 && REGEX_FLAGS.test(text.slice(at, end))) return false;
  STRING_END.lastIndex = end;
  return STRING_END.test(text);
}
/**
 * A WordPress nonce: a `_wpnonce` value, its hidden input, a script's nonce setting or header. The input's attributes
 * are read up to the next `<` too, not only `>`: otherwise every `<input` of a text with no `>` after it is read to
 * its end (100 KB of `<input ` took 5 s, a 20 MiB file hours).
 */
const WP_NONCE = /(?:_wpnonce\s*[=:]\s*["']?[0-9a-f]{10}\b|<input\b(?=[^<>]*\bname=["']_wpnonce["'])(?=[^<>]*\bvalue=["'][0-9a-f]{10}["'])[^<>]*|["']?(?:nonce|ajax_nonce|restNonce|security)["']?\s*[:=]\s*["'][0-9a-f]{10}["'])/iu;
const NONCE_HEADER = /x-wp-nonce/giu;
const SPACES = /\s*/uy;

/** Whether the character is a quote (`"` or `'`). */
function quote(character: string | undefined): boolean {
  return character === '"' || character === "'";
}

/**
 * Where the WordPress REST nonce header with its value starts, or -1, as the pattern
 * `["']?X-WP-Nonce["']?\s*:\s*["'][A-Za-z0-9_-]{10,}["']` (case-insensitive, Unicode) finds it: its value is a base64url
 * run (with `ſ` and the Kelvin sign, which that pattern's case folding reads as `s` and `k`) of 10 characters at least
 * between quotes. Read by hand: the pattern threw a stack overflow on a value of 6 MiB. Each part of the text is read
 * for one header at most: a header whose value is being read is followed by a value character, never by `:` or a quote.
 */
function nonceHeaderIndex(text: string): number {
  const header = new RegExp(NONCE_HEADER.source, NONCE_HEADER.flags);
  for (let match = header.exec(text); match; match = header.exec(text)) {
    let cursor = match.index + match[0].length;
    if (quote(text[cursor])) cursor += 1;
    SPACES.lastIndex = cursor;
    SPACES.exec(text);
    if (text[SPACES.lastIndex] !== ":") continue;
    SPACES.lastIndex += 1;
    SPACES.exec(text);
    if (!quote(text[SPACES.lastIndex])) continue;
    const valueStart = SPACES.lastIndex + 1;
    let valueEnd = valueStart;
    for (let code = text.charCodeAt(valueEnd); base64url(code) || code === 0x17f || code === 0x212a; code = text.charCodeAt(valueEnd)) valueEnd += 1;
    if (valueEnd - valueStart >= 10 && quote(text[valueEnd])) return quote(text[match.index - 1]) ? match.index - 1 : match.index;
  }
  return -1;
}

/** Where a WordPress nonce starts (WP_NONCE or the REST header, nonceHeaderIndex), or -1. */
function wordpressNonceIndex(text: string): number {
  const nonce = WP_NONCE.exec(text)?.index ?? -1;
  const header = nonceHeaderIndex(text);
  return nonce < 0 ? header : header < 0 ? nonce : Math.min(nonce, header);
}
/**
 * Where a web address starts: `http://` or `https://`, JSON-escaped too (`https:\/\/`, `https:\\\/\\\/`), never as the
 * end of a longer scheme name. Protocol-relative addresses (`//host/…`) are not web addresses here: in a text they
 * cannot be told from a path or a comment.
 */
const WEB_ADDRESS = /(?<![A-Za-z0-9+.-])https?:(?:\/\/|\\{1,7}\/\\{1,7}\/)/giu;
/** The characters a host with its port may be read from; the name is then checked whole (PUBLIC_HOST). */
const AUTHORITY_CHARACTER = /[A-Za-z0-9.:@%_~!$&*+=-]/u;
/**
 * A public DNS name, with an optional port: two labels at least, the last one letters or punycode, so never an IP
 * literal (`127.0.0.1`, `[::1]`), a single-label host (`intranet`) or a name with user info or percent-escapes.
 */
const PUBLIC_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})(?::\d{1,5})?$/iu;
/** Names that never reach a public site: the machine itself and the special-use or private-network suffixes. */
const PRIVATE_HOST = /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|test|invalid|example|arpa)(?::\d+)?$/iu;
/**
 * A character of an address's path besides `/`, `%`, `(`, `)` and `&` (pathEnd): RFC 3986's pchar (unreserved,
 * sub-delims, `:` and `@`) and the letters, marks and digits of any script as an IRI writes them, but `'`, which ends
 * a single-quoted attribute or string before it would be the path's.
 */
const PATH_CHARACTER = /^[\p{L}\p{M}\p{N}_\-.~!$*+,;=:@]$/u;
/** An HTML character reference at the start of the text: numeric (`;` optional, as browsers read it) or named. */
const CHARACTER_REFERENCE = /^&(?:#(\d{1,7});?|#[xX]([\da-fA-F]{1,6});?|([A-Za-z][A-Za-z\d]{1,31})(;?))/u;
/** The named references browsers also read without `;`, none of them a character of a path. */
const LEGACY_REFERENCE = /^(?:quot|QUOT|apos|lt|LT|gt|GT|nbsp)$/u;
const LONGEST_AUTHORITY = 260;
/**
 * The folders a hosting account has right under /home/<account>/: its site (cPanel's public_html, DirectAdmin's
 * private_html, the htdocs or httpdocs of others, www on Alwaysdata-like hosts, the domains/ and subdomains/ of
 * DirectAdmin and Hostinger, wp-content when WordPress sits in the account itself), and cPanel's logs/ and tmp/. After
 * the account in a public address's path they are still the server's layout, as a wrong upload_url_path or
 * WP_CONTENT_URL writes it (https://www.sito.it/home/utente/public_html/wp-content/uploads/a.jpg). Each is one with a
 * slash after it; those no page is named like (HOSTING_ROOT) also where the path ends. Not web, html, sites or wp: no
 * panel puts them right under the account but HestiaCP/VestaCP's web/<domain>/public_html (DOCUMENT_ROOT finds it),
 * and they are what a page under /home/ is named like (https://www.sito.it/home/servizi/web/).
 */
const HOSTING_FOLDER = /^(?:public_html|private_html|www|htdocs|httpdocs|domains|subdomains|wp-content|logs|tmp)$/iu;
const HOSTING_ROOT = /^(?:public_html|private_html|htdocs|httpdocs|subdomains|wp-content)$/iu;
/** A site's document root, which is the server's layout anywhere in the first HOSTING_DEPTH folders after /home/. */
const DOCUMENT_ROOT = /^(?:public_html|private_html|htdocs|httpdocs)$/iu;
/** /home/<account>/web/<domain>/public_html: the deepest a panel puts a site's document root. */
const HOSTING_DEPTH = 4;
/** A `..` folder among the pieces of a written folder split at `/` and `\`, with or without `;` parameters. */
const PARENT_PIECE = /(?:^|[/\\])\.\.(?:[;/\\]|$)/u;
const PERCENT_ASCII = /%([\da-fA-F]{2})/gu;
const NUMERIC_REFERENCE = /&#(\d{1,7});?|&#[xX]([\da-fA-F]{1,6});?/gu;
/** What a browser drops from an address before reading it (WHATWG URL): ASCII tab and newline, also as named references. */
const DROPPED = /[\t\n\r]|&(?:Tab|NewLine);/gu;
/** The same, or a numeric reference to one of them, at the start of the text: where pathEnd stops and a browser does not. */
const DROPPED_AT = /^(?:[\t\n\r]|&(?:Tab|NewLine);|&#0*(?:9|10|13)(?!\d);?|&#[xX]0*[9aAdD](?![\da-fA-F]);?)/u;

/** The ASCII character of a `%XX` or a numeric character reference (NUMERIC_REFERENCE), or the text as written. */
function ascii(written: string, decimal?: string, hex?: string): string {
  const code = written.startsWith("%") ? Number.parseInt(decimal!, 16) : decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
  return code < 0x80 ? String.fromCharCode(code) : written;
}

/**
 * `text` with each match of `pattern` (PERCENT_ASCII or NUMERIC_REFERENCE) replaced by its ASCII character, as
 * `text.replace(pattern, ascii)` does, read match by match into one buffer: a replace with a function holds every match
 * at once, and 3 M of them (12 MiB of `a%5C`) took over 1 GB. Each replacement is no longer than its match.
 */
function decodeEach(text: string, pattern: RegExp): string {
  if (text.search(pattern) < 0) return text;
  const decoded = new Uint16Array(text.length);
  let length = 0;
  let copied = 0;
  const copy = (source: string, from: number, to: number) => {
    for (let index = from; index < to; index += 1) decoded[length++] = source.charCodeAt(index);
  };
  const matcher = new RegExp(pattern.source, pattern.flags);
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    copy(text, copied, match.index);
    const character = ascii(match[0], match[1], match[2]);
    copy(character, 0, character.length);
    copied = match.index + match[0].length;
  }
  copy(text, copied, text.length);
  const parts: string[] = [];
  for (let index = 0; index < length; index += 8192) parts.push(String.fromCharCode(...decoded.subarray(index, Math.min(length, index + 8192))));
  return parts.join("");
}

/**
 * The length of the slash at `at`: 1, or 1 more than its backslashes when JSON-escaped (`\/`, `\\\/`, seven backslashes
 * at most, as ESCAPED); 0 for none.
 */
function slash(text: string, at: number): number {
  if (text[at] === "/") return 1;
  let cursor = at;
  while (text[cursor] === "\\" && cursor - at < 7) cursor += 1;
  return cursor > at && text[cursor] === "/" ? cursor - at + 1 : 0;
}

/** Whether a character reference (a CHARACTER_REFERENCE match) stands for a character of a path. */
function pathReference(reference: RegExpExecArray): boolean {
  const [, decimal, hex, name, semicolon] = reference;
  if (name !== undefined) return semicolon === ";" && (name === "amp" || name === "sol");
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
  if (code > 0x10ffff) return false;
  const character = String.fromCodePoint(code);
  return character === "/" || character === "&" || (PATH_CHARACTER.test(character) && character !== "*");
}

/**
 * Where the path of an address ends, read from `start` (a slash) as RFC 3986 reads it: pchar (PATH_CHARACTER, `%` with
 * two hex digits, `&`) and `/`, JSON-escaped too. So it ends at `?` and `#` (the query and the fragment are not the
 * path), at a space, a quote, `<`, `>` or a backslash. It also ends where an address in HTML, CSS or a script ends though
 * RFC 3986 would go on: at a `)` with no `(` before it in the path (CSS url(…), a link in parentheses; Wikipedia's
 * /wiki/Home_(film) stays whole), at `/*` and `*\/` (a comment), at a `%` without two hex digits, and at a character
 * reference that is no character of a path (`&quot;` ends it, `&amp;` and `&#47;` do not). It is not read past `limit`.
 */
function pathEnd(text: string, start: number, limit = text.length): number {
  let cursor = start;
  let depth = 0;
  while (cursor < limit) {
    const separator = slash(text, cursor);
    if (separator) {
      if (text[cursor + separator] === "*") break;
      cursor += separator;
      continue;
    }
    const character = String.fromCodePoint(text.codePointAt(cursor)!);
    if (character === "*" && slash(text, cursor + 1)) break;
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (character === "%") {
      if (!/^[\da-fA-F]{2}$/u.test(text.slice(cursor + 1, cursor + 3))) break;
      cursor += 3;
      continue;
    } else if (character === "&") {
      const reference = CHARACTER_REFERENCE.exec(text.slice(cursor, cursor + 40));
      // A name without `;` is a reference only for the legacy ones: `&b=1` is the path's own `&`.
      if (reference && (reference[3] === undefined || reference[4] === ";" || LEGACY_REFERENCE.test(reference[3]))) {
        if (!pathReference(reference)) break;
        cursor += reference[0].length;
        continue;
      }
    } else if (!PATH_CHARACTER.test(character)) break;
    cursor += character.length;
  }
  return Math.min(cursor, limit);
}

/**
 * The path of each http(s) address of `text` whose host is a public DNS name, as [start, end) offsets in the order of
 * the text: a /home/ there is a page of a public site (https://www.comune.example.it/home/servizi), not a folder of the
 * server. Loopback and private hosts, IP literals and user info keep their paths matched, with every address written
 * inside them; an address written inside a public one's path (https://web.archive.org/web/2020/https://…) ends that
 * path and is read on its own, so that its own host decides. A public path is read only up to the next address
 * (found once for all the addresses before it), never to the end of a run of them and back: `,` and `:` are a path's,
 * so a gallery's `https://cdn…/0.jpg,https://cdn…/1.jpg,…` read each path to the run's end, and 256 KB took 18 s.
 */
function publicAddressPaths(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const pattern = new RegExp(WEB_ADDRESS.source, WEB_ADDRESS.flags);
  const nested = new RegExp(WEB_ADDRESS.source, WEB_ADDRESS.flags);
  let next: RegExpExecArray | null | undefined;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    let cursor = match.index + match[0].length;
    const authorityStart = cursor;
    while (cursor < text.length && cursor - authorityStart <= LONGEST_AUTHORITY && AUTHORITY_CHARACTER.test(text[cursor]!)) cursor += 1;
    const authority = text.slice(authorityStart, cursor);
    const pathStart = cursor;
    if (slash(text, pathStart)) {
      if (PUBLIC_HOST.test(authority) && !PRIVATE_HOST.test(authority)) {
        if (next === undefined || (next !== null && next.index < pathStart)) {
          nested.lastIndex = pathStart;
          next = nested.exec(text);
        }
        cursor = pathEnd(text, pathStart, next ? next.index : text.length);
        spans.push([pathStart, cursor]);
      } else cursor = pathEnd(text, pathStart);
    }
    pattern.lastIndex = Math.max(pattern.lastIndex, cursor);
  }
  return spans;
}

/**
 * Where a browser reads the path of a public address that pathEnd ends at `end` to: on past a backslash (a slash to it)
 * and past an ASCII tab or newline (dropped), also written as a character reference, then as pathEnd reads it, never
 * past `limit` (the next public address's path, so that each part of the text is read for one address only).
 */
function layoutEnd(text: string, end: number, limit: number): number {
  let cursor = end;
  while (cursor < limit) {
    let skip = 0;
    while (text[cursor + skip] === "\\") skip += 1;
    if (!skip) skip = DROPPED_AT.exec(text.slice(cursor, cursor + 12))?.[0].length ?? 0;
    if (!skip) break;
    cursor = pathEnd(text, cursor + skip, limit);
  }
  return Math.min(cursor, limit);
}

/**
 * Whether the account whose name starts at `at`, in a public address's path that ends at `end`, is followed by one of
 * a hosting account's folders (HOSTING_FOLDER), or by a document root (DOCUMENT_ROOT) in the first HOSTING_DEPTH
 * folders: /home/<account>/public_html/… is the server's layout wherever it is. The folders are read as a browser and
 * then a server read them: a numeric character reference of an ASCII character decoded (`&#112;ublic_html`), ASCII tab
 * and newline dropped (WHATWG URL, `public&#9;_html`), `%XX` of an ASCII character decoded once (`%70ublic_html`), a
 * backslash read as a slash as a browser reads it in an http(s) path (`utente\public_html`, `%5C` too), JSON-escaped
 * slashes too, `;` parameters dropped, empty and `.` folders skipped (`/home//utente/./public_html`); a `..` is the
 * server's layout too, not a page. `end` is where layoutEnd says the path goes on to.
 */
function hostingLayout(text: string, at: number, end: number): boolean {
  const folders: Array<[string, boolean]> = [];
  let cursor = at;
  while (cursor < end && folders.length < HOSTING_DEPTH) {
    let stop = cursor;
    while (stop < end && !slash(text, stop)) stop += 1;
    const separator = stop < end ? slash(text, stop) : 0;
    const written = text.slice(cursor, stop);
    const decoded = /[&%\\\t\n\r]/u.test(written) ? decodeEach(decodeEach(written, NUMERIC_REFERENCE).replace(DROPPED, ""), PERCENT_ASCII) : written;
    // Its pieces (split at `/` and `\`): a `..` among any of them, then the folders up to HOSTING_DEPTH, read in place,
    // never as an array of every piece (a run of `a\` took 1.3 GB at 24 MiB, and aborted the process with less heap).
    if (PARENT_PIECE.test(decoded)) return true;
    for (let from = 0; from <= decoded.length && folders.length < HOSTING_DEPTH; ) {
      let to = from;
      let parameters = -1;
      for (; to < decoded.length && decoded[to] !== "/" && decoded[to] !== "\\"; to += 1) if (parameters < 0 && decoded[to] === ";") parameters = to;
      const folder = decoded.slice(from, parameters < 0 ? to : parameters);
      if (folder !== "" && folder !== ".") folders.push([folder, to < decoded.length || separator > 0]);
      from = to + 1;
    }
    cursor = stop + separator;
  }
  if (folders.length < 2) return false;
  const [folder, followed] = folders[1]!;
  if (followed ? HOSTING_FOLDER.test(folder) : HOSTING_ROOT.test(folder)) return true;
  return folders.slice(1, HOSTING_DEPTH).some(([name]) => DOCUMENT_ROOT.test(name));
}

/**
 * Where the content shows a folder of the server, or -1. Only a home folder inside the path of a public address
 * (publicAddressPaths) is not one, unless a hosting account's folders follow it (hostingLayout); /var/www/ and
 * inetpub are one wherever they are written.
 */
function serverPathIndex(text: string): number {
  const pattern = new RegExp(SERVER_PATH.source, SERVER_PATH.flags);
  let spans: Array<[number, number]> | undefined;
  let span = 0;
  const layoutEnds: number[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const home = /home/iu.exec(match[0]);
    if (!home) return match.index;
    if (match[1] !== undefined) {
      // `/home\/` after a backslash is the rest of an escaped home already judged from its first backslash.
      if (match[1].startsWith("/") && text[match.index - 1] === "\\") {
        pattern.lastIndex = match.index + 1;
        continue;
      }
      if (!escapedHomeFolder(text, match.index + match[0].length)) {
        pattern.lastIndex = match.index + 1;
        continue;
      }
    }
    // The folder's own part, up to the separator after "home": the account's name starts after it.
    const homeEnd = match.index + home.index + home[0].length;
    const end = homeEnd + Math.max(1, slash(text, homeEnd));
    spans ??= publicAddressPaths(text);
    while (span < spans.length && spans[span]![1] < end) span += 1;
    const inside = span < spans.length && spans[span]![0] <= match.index && end <= spans[span]![1];
    if (!inside) return match.index;
    layoutEnds[span] ??= layoutEnd(text, spans[span]![1], spans[span + 1]?.[0] ?? text.length);
    if (hostingLayout(text, end, layoutEnds[span]!)) return match.index;
    pattern.lastIndex = match.index + 1;
  }
  return -1;
}

/**
 * A slash or a colon written as a character reference (`&#47;`, `&#x2F;`, `&sol;`, `&#58;`, `&colon;`), a script's
 * escape (`/`, `\u{2f}`, `\x2F`) or percent-encoded (`%2F`, `%3A`), as a browser, a script or a server decodes
 * it. The colon too, so that an address written this way (a share link's `?u=https%3A%2F%2F…`) is still an address.
 */
const ENCODED_SEPARATOR = /&#0*(?:47|58)(?!\d);?|&#[xX]0*(?:2[fF]|3[aA])(?![\da-fA-F]);?|&(?:sol|colon);|\\u(?:00(?:2[fF]|3[aA])|\{0*(?:2[fF]|3[aA])\})|\\x(?:2[fF]|3[aA])|%(?:2[fF]|3[aA])/gu;

/**
 * Where the content shows a folder of the server (serverPathIndex), also with its slashes written as references,
 * escapes or percent-encoding (ENCODED_SEPARATOR, `&#47;home&#47;utente`, `/home/utente`, `%2Fhome%2Futente`):
 * the same rules run on a copy with those decoded, and what they find there is placed back in the text as written.
 */
function encodedServerPathIndex(text: string): number {
  const direct = serverPathIndex(text);
  if (text.search(ENCODED_SEPARATOR) < 0) return direct;
  const found = serverPathIndex(text.replace(ENCODED_SEPARATOR, (token: string) => (/47|2f|sol/iu.test(token) ? "/" : ":")));
  if (found < 0) return direct;
  // Back to the text as written, walking its tokens again (no table of them: a file may hold millions): each one
  // before the place moved it by its length less the one character it decodes to; the place may be a token itself.
  const tokens = new RegExp(ENCODED_SEPARATOR.source, ENCODED_SEPARATOR.flags);
  let shrunk = 0;
  let place = -1;
  for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
    const decodedAt = token.index - shrunk;
    if (decodedAt >= found) {
      if (decodedAt === found) place = token.index;
      break;
    }
    shrunk += token[0].length - 1;
  }
  if (place < 0) place = found + shrunk;
  return direct < 0 ? place : Math.min(direct, place);
}

/**
 * The local part of an e-mail address with its `@`, read from where its run starts (never from inside it). The rule
 * is still the old `\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`, found at the same place: that pattern read a run again
 * from each word boundary inside it, and 100 KB of `%2F%2F…` (a percent-encoded SVG, a URL-encoded query) took 9 s, a
 * 20 MiB file hours. Here each run is read once (its first word character is where the old one started: before it a
 * `\b` cannot be), and the domain once after each `@` (EMAIL_DOMAIN, with no `@` in it, so the domains never overlap).
 */
const EMAIL_LOCAL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@/giu;
const EMAIL_DOMAIN = /[A-Z0-9.-]+\.[A-Z]{2,}\b/iuy;

/** Where the first e-mail address of the text starts, or -1. */
function emailAddressIndex(text: string): number {
  const local = new RegExp(EMAIL_LOCAL.source, EMAIL_LOCAL.flags);
  for (let match = local.exec(text); match; match = local.exec(text)) {
    const word = /[A-Z0-9_]/iu.exec(match[0]);
    EMAIL_DOMAIN.lastIndex = match.index + match[0].length;
    if (word && word.index < match[0].length - 1 && EMAIL_DOMAIN.test(text)) return match.index + word.index;
  }
  return -1;
}

/**
 * A namespace declaration of the W3C namespaces (SVG, XLink, XHTML, XML) as an `xmlns` or `xmlns:prefix` attribute
 * writes it, inside a data: URI or a CSS/JS string too: quoted with the same quote on both sides, raw, backslash-escaped,
 * as a character reference or percent-encoded (`xmlns=%27http://www.w3.org/2000/svg%27`). The URI only names the
 * vocabulary, nothing loads it. No word boundary before `xmlns`: a data: URI writes `%20xmlns`. Group 2 is the URI;
 * unquoted, or any other address, it is still a link.
 */
const NAMESPACE_DECLARATION = /xmlns(?::[A-Za-z_][\w.-]{0,63})?[ \t\r\n]{0,8}=[ \t\r\n]{0,8}(["']|\\["']|&quot;|&#0{0,3}3[49];|&apos;|%2[27])(http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace))\1/gu;

/** Where the first `http://` of the text starts that is not a namespace URI (NAMESPACE_DECLARATION), or -1. */
function insecureHttpIndex(text: string): number {
  const namespaces = new Set<number>();
  const declaration = new RegExp(NAMESPACE_DECLARATION.source, NAMESPACE_DECLARATION.flags);
  for (let match = declaration.exec(text); match; match = declaration.exec(text)) {
    const [whole, quoteMark = "", uri = ""] = match;
    namespaces.add(match.index + whole.length - quoteMark.length - uri.length);
  }
  const http = /http:\/\//giu;
  for (let match = http.exec(text); match; match = http.exec(text)) {
    if (!namespaces.has(match.index)) return match.index;
  }
  return -1;
}

export interface ScannableFile {
  path: string;
  contents?: Buffer;
  size: number;
}

function lineAt(contents: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (contents.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function pushFinding(findings: Finding[], finding: Finding): void {
  const key = `${finding.code}\u0000${finding.file}\u0000${finding.line ?? 0}`;
  if (!findings.some((item) => `${item.code}\u0000${item.file}\u0000${item.line ?? 0}` === key)) findings.push(finding);
}

export function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function scanFiles(files: readonly ScannableFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const normalizedPath = file.path.replaceAll("\\", "/");
    const pathNameRule = BLOCKED_NAMES.find((rule) => rule.test(normalizedPath));
    if (pathNameRule) {
      pushFinding(findings, {
        code: "sensitive-file",
        severity: "block",
        file: normalizedPath,
        message: "Il nome del file indica configurazione privata o dati di backup.",
      });
    }
    if (isServerExecutablePath(normalizedPath)) {
      pushFinding(findings, { code: "server-executable-file", severity: "block", file: normalizedPath, message: "Il bundle contiene un file eseguibile lato server." });
    }

    if (file.size > 5 * 1024 * 1024) {
      pushFinding(findings, {
        code: "large-file",
        severity: "warn",
        file: normalizedPath,
        message: "Il file supera 5 MiB.",
      });
    }
    if (isTextFile(normalizedPath) && file.size > MAX_TEXT_SCAN_BYTES) {
      pushFinding(findings, {
        code: "text-file-too-large-to-scan",
        severity: "block",
        file: normalizedPath,
        message: "Il file di testo è troppo grande per essere controllato in sicurezza.",
      });
      continue;
    }
    if (!file.contents || !isTextFile(normalizedPath)) continue;

    const text = file.contents.toString("utf8");
    const serverPath = encodedServerPathIndex(text);
    if (serverPath >= 0) {
      pushFinding(findings, { code: "server-path", severity: "block", file: normalizedPath, line: lineAt(text, serverPath), message: "Il contenuto espone un percorso del server." });
    }
    const fileUrl = /file:\/\//iu.exec(text);
    if (fileUrl?.index !== undefined) {
      pushFinding(findings, { code: "filesystem-url", severity: "block", file: normalizedPath, line: lineAt(text, fileUrl.index), message: "Il contenuto contiene un URL del filesystem locale." });
    }
    const nonce = wordpressNonceIndex(text);
    if (nonce >= 0) {
      pushFinding(findings, { code: "wordpress-nonce", severity: "block", file: normalizedPath, line: lineAt(text, nonce), message: "Il contenuto contiene un nonce o un riferimento a un nonce WordPress." });
    }
    for (const index of [secretKeyIndex(text), googleKeyIndex(text), PRIVATE_KEY.exec(text)?.index ?? -1, jsonWebTokenIndex(text)]) {
      if (index >= 0) {
        pushFinding(findings, { code: "secret-pattern", severity: "block", file: normalizedPath, line: lineAt(text, index), message: "Il contenuto sembra contenere una chiave o un token privato." });
      }
    }
    if (/\bxb_preview=/iu.test(text)) {
      const index = text.search(/\bxb_preview=/iu);
      pushFinding(findings, { code: "preview-token", severity: "block", file: normalizedPath, line: lineAt(text, index), message: "Il contenuto contiene un token di anteprima." });
    }
    if (/\b(?:ABSPATH|WP_CONTENT_DIR)\b/u.test(text)) {
      const index = text.search(/\b(?:ABSPATH|WP_CONTENT_DIR)\b/u);
      pushFinding(findings, { code: "wordpress-server-constant", severity: "block", file: normalizedPath, line: lineAt(text, index), message: "Il contenuto espone un riferimento interno di WordPress." });
    }
    const builderAnnotation = /data-xb-uid/iu.exec(text);
    if (builderAnnotation?.index !== undefined) {
      pushFinding(findings, { code: "builder-annotation", severity: "block", file: normalizedPath, line: lineAt(text, builderAnnotation.index), message: "Il contenuto include annotazioni interne del builder." });
    }
    const email = emailAddressIndex(text);
    if (email >= 0) {
      pushFinding(findings, { code: "email-address", severity: "warn", file: normalizedPath, line: lineAt(text, email), message: "Il contenuto include un indirizzo email.", });
    }
    const phone = /\btel:/iu.exec(text);
    if (phone?.index !== undefined) {
      pushFinding(findings, { code: "phone-number", severity: "warn", file: normalizedPath, line: lineAt(text, phone.index), message: "Il contenuto include un collegamento telefonico." });
    }
    const privateIp = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/u.exec(text);
    if (privateIp?.index !== undefined) {
      pushFinding(findings, { code: "private-ip", severity: "warn", file: normalizedPath, line: lineAt(text, privateIp.index), message: "Il contenuto include un indirizzo IP privato." });
    }
    const http = insecureHttpIndex(text);
    if (http >= 0) {
      pushFinding(findings, { code: "insecure-http-link", severity: "warn", file: normalizedPath, line: lineAt(text, http), message: "Il contenuto include un collegamento HTTP non cifrato." });
    }
    for (const rule of DYNAMIC_PATHS) {
      const match = rule.pattern.exec(text);
      if (match?.index !== undefined) pushFinding(findings, { code: rule.code, severity: "warn", file: normalizedPath, line: lineAt(text, match.index), message: rule.message });
    }
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file, "en") || left.code.localeCompare(right.code, "en") || (left.line ?? 0) - (right.line ?? 0));
}
