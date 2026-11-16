import { describe, expect, it } from "vitest";
import { ConnectorChoices } from "../src/connector-choices.js";

/** Doc 27, «Claude dal connettore»: a question waits for the agent; only its shape is checked here. */
const request = (ids: string[], signal = new AbortController().signal) => ({
  system: "regole",
  user: "<<<DATI\n[]\nDATI>>>",
  schema: {},
  idSchema: { properties: { scelte: { items: { properties: { id: { enum: ids } } } } } },
  signal,
});

describe("ConnectorChoices", () => {
  it("la domanda aspetta l'agente; la risposta torna al convertitore come testo JSON", async () => {
    const choices = new ConnectorChoices();
    expect(await choices.next(0)).toBeNull();
    const pending = choices.ask("officina")(request(["classe:a__b", "classe:a__c"]));
    const question = await choices.next(0);
    expect(question).toMatchObject({ site: "officina", count: 2, system: "regole", choices: "<<<DATI\n[]\nDATI>>>" });
    expect(choices.waiting).toBe(true);
    expect(choices.answer(question?.requestId as string, JSON.stringify({ scelte: [{ id: "classe:a__b", valore: "a__titolo" }] }))).toEqual({ received: 1 });
    expect(JSON.parse(await pending)).toEqual({ scelte: [{ id: "classe:a__b", valore: "a__titolo" }] });
    expect(choices.waiting).toBe(false);
  });

  it("con waitSeconds l'agente aspetta che una domanda arrivi", async () => {
    const choices = new ConnectorChoices();
    const waiting = choices.next(5);
    const pending = choices.ask("officina")(request(["tipo:x"]));
    const question = await waiting;
    expect(question?.count).toBe(1);
    choices.answer(question?.requestId as string, '{"scelte":[]}');
    expect(await pending).toBe('{"scelte":[]}');
  });

  it("rifiuta id sconosciuti, JSON rotto, voci di troppo o senza testo; Annulla e il tempo chiudono la domanda", async () => {
    const choices = new ConnectorChoices({ waitMs: 50 });
    const controller = new AbortController();
    const pending = choices.ask("officina")(request(["tipo:x"], controller.signal));
    const question = await choices.next(0);
    const id = question?.requestId as string;
    expect(() => choices.answer("00000000-0000-4000-8000-000000000000", '{"scelte":[]}')).toThrow(expect.objectContaining({ code: "connector-choices-missing", exitCode: 404 }));
    expect(() => choices.answer(id, "{rotto")).toThrow(expect.objectContaining({ code: "connector-choices-invalid" }));
    expect(() => choices.answer(id, '{"altro":[]}')).toThrow(expect.objectContaining({ code: "connector-choices-invalid" }));
    expect(() => choices.answer(id, '{"scelte":[{"id":"tipo:x","valore":"a"},{"id":"tipo:x","valore":"b"}]}')).toThrow(/Troppe voci/u);
    expect(() => choices.answer(id, '{"scelte":[{"id":"tipo:x","valore":3}]}')).toThrow(expect.objectContaining({ code: "connector-choices-invalid" }));
    controller.abort();
    await expect(pending).rejects.toThrow("fermato");
    expect(await choices.next(0)).toBeNull();
    // The time limit, and a new import replacing a question nobody answered.
    await expect(choices.ask("officina")(request(["tipo:x"]))).rejects.toThrow(/non ha risposto in tempo/u);
    const first = choices.ask("uno")(request(["tipo:x"]));
    const second = choices.ask("due")(request(["tipo:y"]));
    await expect(first).rejects.toThrow(/sostituita/u);
    expect((await choices.next(0))?.site).toBe("due");
    choices.answer((await choices.next(0))?.requestId as string, '{"scelte":[]}');
    await second;
  });
});
