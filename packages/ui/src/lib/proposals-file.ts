/** A proposal of a kit proposte file, as the choice shows it. `doc` is the proposal's whole HTML document. */
export interface ProposalChoice {
  id: string;
  name: string;
  group: string;
  idea: string;
  doc: string;
}

/** What the choice of a proposal shows of a kit proposte file: the server reads the file again and checks all of it. */
export interface ProposalChoices {
  title: string;
  groups: Array<{ id: string; name: string }>;
  proposals: ProposalChoice[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a kit proposte file in the page, for the choice only: the same defaults as the server's readProposalsFile
 * (title "Proposte", a name that is the id when there is none). Null when the file is not one, or has no proposal
 * with an id and a document.
 */
export function readProposalChoices(html: string): ProposalChoices | null {
  const text = new DOMParser().parseFromString(html, "text/html").getElementById("kp-dati")?.textContent;
  if (typeof text !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data.proposte)) return null;

  const proposals: ProposalChoice[] = [];
  for (const item of data.proposte) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.doc !== "string") continue;
    const id = item.id;
    proposals.push({
      id,
      name: typeof item.nome === "string" && item.nome.trim() !== "" ? item.nome.trim() : id,
      group: typeof item.gruppo === "string" ? item.gruppo.trim() : "",
      idea: typeof item.idea === "string" ? item.idea.trim() : "",
      doc: item.doc,
    });
  }
  if (proposals.length === 0) return null;

  const groups: ProposalChoices["groups"] = [];
  if (Array.isArray(data.gruppi)) {
    for (const item of data.gruppi) {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") continue;
      const id = item.id;
      groups.push({ id, name: typeof item.nome === "string" && item.nome.trim() !== "" ? item.nome.trim() : id });
    }
  }

  const title = typeof data.titolo === "string" && data.titolo.trim() !== "" ? data.titolo.trim() : "Proposte";
  return { title, groups, proposals };
}
