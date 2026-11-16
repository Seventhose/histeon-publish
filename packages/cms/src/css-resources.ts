import { cssResourceReferences, type CssAssetReference, type CssResourceReference } from "@histos-publish/histos-contract/css-resources";

export { cssResourceReferences };
export type { CssAssetReference, CssResourceReference };

export function unbundledCssResources(css: string): CssResourceReference[] {
  return cssResourceReferences(css).filter((reference) => !reference.external);
}

export function assertCssResourcesBundled(entries: Array<{ label: string; css: string; assets?: CssAssetReference[] }>): void {
  for (const entry of entries) {
    const assets = new Map((entry.assets ?? []).map((asset) => [asset.reference, asset.assetId]));
    const reference = unbundledCssResources(entry.css).find((item) => item.kind === "import" || !assets.has(item.value));
    if (reference) {
      const reason = reference.kind === "import" ? "Gli import locali di altri fogli CSS non sono supportati" : "Il file collegato non è ancora incluso nel progetto";
      throw new TypeError(`Il foglio CSS “${entry.label}” usa il riferimento locale “${reference.value}” (${reference.kind}). ${reason}; aggiungi il file collegato o rimuovi il riferimento prima di compilare.`);
    }
  }
}

/** Rewrites only URLs with a project-owned mapping; useful while the editor has unsaved CSS. */
export function rewriteMappedCssAssetUrls(
  css: string,
  assets: CssAssetReference[],
  assetUrl: (assetId: string) => string,
): string {
  const byReference = new Map(assets.map((asset) => [asset.reference, asset.assetId]));
  let output = css;
  for (const reference of cssResourceReferences(css).filter((item) => !item.external && item.kind === "url").reverse()) {
    const assetId = byReference.get(reference.value);
    if (!assetId) continue;
    const suffixIndex = [reference.value.indexOf("?"), reference.value.indexOf("#")].filter((index) => index >= 0).sort((left, right) => left - right)[0];
    const target = suffixIndex === undefined ? assetUrl(assetId) : assetUrl(assetId) + reference.value.slice(suffixIndex);
    const safeTarget = target.replaceAll("\\", "\\\\").replaceAll('"', "\\\"");
    output = output.slice(0, reference.start) + `url("${safeTarget}")` + output.slice(reference.end);
  }
  return output;
}

export async function rewriteCssAssetUrls(css: string, assets: CssAssetReference[], assetUrl: (assetId: string) => Promise<string> | string): Promise<string> {
  assertCssResourcesBundled([{ label: "foglio globale", css, assets }]);
  const urls = new Map<string, string>();
  for (const asset of assets) if (!urls.has(asset.assetId)) urls.set(asset.assetId, await assetUrl(asset.assetId));
  return rewriteMappedCssAssetUrls(css, assets, (assetId) => urls.get(assetId) ?? "");
}
