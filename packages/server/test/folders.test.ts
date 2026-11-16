import { describe, expect, it } from "vitest";
import { createFolder, deleteFolder, dropMember, emptyFolders, folderName, moveToFolder, readFolders, renameFolder } from "../src/folders.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("cartelle di progetti e siti", () => {
  it("crea, sposta, rinomina ed elimina: eliminare una cartella riporta fuori quello che conteneva", () => {
    const state = emptyFolders();
    const proposals = createFolder(state, "cms", "  Proposte   Scrittori  ");
    expect(proposals.name).toBe("Proposte Scrittori");
    expect(moveToFolder(state, "cms", [A, B], proposals.id, new Set([A, B]))).toBe(2);
    expect(state.members.cms).toEqual({ [A]: proposals.id, [B]: proposals.id });
    moveToFolder(state, "cms", [B], null, new Set([A, B]));
    expect(state.members.cms).toEqual({ [A]: proposals.id });
    expect(renameFolder(state, proposals.id, "Versioni").name).toBe("Versioni");
    deleteFolder(state, proposals.id);
    expect(state).toEqual(emptyFolders());
  });

  it("rifiuta nomi vuoti, troppo lunghi o con caratteri di controllo, elementi sconosciuti e cartelle di un altro elenco", () => {
    const state = emptyFolders();
    expect(() => folderName("   ")).toThrow(/da 1 a 80/u);
    expect(() => folderName("x".repeat(81))).toThrow(/da 1 a 80/u);
    expect(() => folderName("a\u0007b")).toThrow(/da 1 a 80/u);
    expect(() => createFolder(state, "other", "X")).toThrow(/Tipo/u);
    const sites = createFolder(state, "sites", "Clienti");
    expect(() => moveToFolder(state, "cms", [A], sites.id, new Set([A]))).toThrow(/altro elenco/u);
    expect(() => moveToFolder(state, "cms", [A], null, new Set([B])), "an unknown id").toThrow(/non validi/u);
    expect(() => moveToFolder(state, "cms", [], null, new Set([A]))).toThrow(/non validi/u);
    expect(() => moveToFolder(state, "sites", [A], "nope", new Set([A]))).toThrow(/non esiste/u);
  });

  it("legge l'impostazione salvata scartando ciò che non torna", () => {
    const state = readFolders({
      folders: [{ id: A, kind: "cms", name: "Buona", createdAt: "2026-10-29" }, { id: "../x", kind: "cms", name: "Cattiva" }, { id: B, kind: "boh", name: "Tipo sbagliato" }, { id: A, kind: "cms", name: "Doppia" }],
      members: { cms: { [B]: A, "../etc": A, [A]: "manca" }, sites: { [B]: A } },
    });
    expect(state.folders.map((folder) => folder.name)).toEqual(["Buona"]);
    expect(state.members).toEqual({ cms: { [B]: A }, sites: {} });
    expect(readFolders("rotto")).toEqual(emptyFolders());
    expect(dropMember(state, "cms", B)).toBe(true);
    expect(dropMember(state, "cms", B)).toBe(false);
  });
});
