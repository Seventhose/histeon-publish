import { randomUUID } from "node:crypto";
import { PROTOTYPE_KITS } from "./prototype-kits.generated.js";

/**
 * The kits to copy (doc 17 item 3): `minimo` is the manual's §1.3, `sito` a whole site with neutral content (every
 * view, mobile menu, current item, form, paging). Both pass the check with the build and no warning (a test keeps them
 * so). The connector has the same function in packages/connector/src/kits.ts, as it is bundled alone.
 */
export { PROTOTYPE_KITS };
export type PrototypeKitKind = keyof typeof PROTOTYPE_KITS;
export const PROTOTYPE_KIT_KINDS = Object.keys(PROTOTYPE_KITS) as PrototypeKitKind[];

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A kit with a new id, so that importing it never updates the project of another prototype; `name` renames it. */
export function prototypeKit(kind: PrototypeKitKind, options: { id?: string; name?: string } = {}): { html: string; id: string } {
  const id = options.id ?? randomUUID();
  const kit = PROTOTYPE_KITS[kind];
  const start = kit.indexOf('data-histos="manifest">');
  const end = kit.indexOf("</script>", start);
  let manifest = kit.slice(start, end).replace(/"id": "[0-9a-f-]{36}"/u, `"id": "${id}"`);
  let html = kit;
  if (options.name !== undefined) {
    const name = options.name.trim();
    if (!name || name.length > 120 || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new RangeError("Il nome del prototipo va da 1 a 120 caratteri, senza caratteri di controllo.");
    manifest = manifest.replace(/"name": "(?:[^"\\]|\\.)*"/u, `"name": ${JSON.stringify(name).replaceAll("</", "<\\/")}`);
    html = html.replace(/<title>[^<]*<\/title>/u, `<title>${escapeHtml(name)}</title>`);
  }
  const at = html.indexOf('data-histos="manifest">');
  return { html: html.slice(0, at) + manifest + html.slice(html.indexOf("</script>", at)), id };
}
