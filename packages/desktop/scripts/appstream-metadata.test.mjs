import assert from "node:assert/strict";
import test from "node:test";
import { createAppStreamMetainfo, validateAppStreamSettings } from "./appstream-metadata.mjs";

const validSettings = {
  id: "it.organizzazione.histospublish",
  homepage: "https://freedesktop.org/software/appstream/docs/",
  maintainer: "Nome Cognome <release@publish.test>",
  developerName: "Nome Cognome",
};

test("accetta identificatore, homepage HTTPS e maintainer dichiarati esplicitamente", () => {
  assert.deepEqual(validateAppStreamSettings(validSettings), {
    ...validSettings,
    homepage: "https://freedesktop.org/software/appstream/docs/",
  });
});

test("rifiuta identificatori senza namespace e homepage di esempio o non HTTPS", () => {
  assert.throws(() => validateAppStreamSettings({ ...validSettings, id: "histos-publish" }), /reverse-DNS/u);
  assert.throws(() => validateAppStreamSettings({ ...validSettings, id: "it.organizzazione.HistosPublish" }), /reverse-DNS/u);
  assert.throws(() => validateAppStreamSettings({ ...validSettings, homepage: "http://publish.example.com" }), /HTTPS/u);
  assert.throws(() => validateAppStreamSettings({ ...validSettings, homepage: "https://product.invalid" }), /dominio di esempio/u);
});

test("rifiuta il maintainer placeholder del candidato", () => {
  assert.throws(() => validateAppStreamSettings({
    ...validSettings,
    maintainer: "Histeon Publish <noreply@example.invalid>",
  }), /senza dati di esempio/u);
});

test("genera metadati AppStream con release, launchable e XML escapato", () => {
  const document = createAppStreamMetainfo({
    ...validSettings,
    version: "1.2.3",
    releaseDate: "2026-10-24",
    developerName: "Histeon & Publish",
  });
  assert.match(document, /<id>it\.organizzazione\.histospublish<\/id>/u);
  assert.match(document, /<url type="homepage">https:\/\/freedesktop\.org\/software\/appstream\/docs\/<\/url>/u);
  assert.match(document, /<launchable type="desktop-id">it\.organizzazione\.histospublish\.desktop<\/launchable>/u);
  assert.match(document, /<developer id="it\.organizzazione">\s*<name>Histeon &amp; Publish<\/name>\s*<\/developer>/u);
  assert.match(document, /<release version="1\.2\.3" date="2026-10-24" \/>/u);
});
