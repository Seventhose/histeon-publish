import parseSrcset from "parse-srcset";

export type SrcsetCandidate = ReturnType<typeof parseSrcset>[number];

export function parseSrcsetCandidates(value: string): SrcsetCandidate[] {
  return parseSrcset(value);
}

export function formatSrcsetCandidate(candidate: SrcsetCandidate): string {
  const descriptors: string[] = [];
  if (candidate.w !== undefined) descriptors.push(`${candidate.w}w`);
  if (candidate.h !== undefined) descriptors.push(`${candidate.h}h`);
  if (candidate.d !== undefined) descriptors.push(`${candidate.d}x`);
  return `${candidate.url}${descriptors.length > 0 ? ` ${descriptors.join(" ")}` : ""}`;
}

export function rewriteSrcset(value: string, rewrite: (url: string) => string): string {
  const candidates = parseSrcsetCandidates(value);
  if (candidates.length === 0) return value;
  return candidates.map((candidate) => formatSrcsetCandidate({ ...candidate, url: rewrite(candidate.url) })).join(", ");
}
