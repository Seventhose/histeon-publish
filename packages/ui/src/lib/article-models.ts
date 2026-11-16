import type { ArticleBlock } from "./article-schema.js";
import type { Language } from "./i18n.js";

/** Structures to start an article from: only headings and hints to write over, so nothing has to be taken out. */
export function articleModels(language: Language): Array<{ key: string; name: string; blocks: ArticleBlock[] }> {
  const heading = (html: string): ArticleBlock => ({ type: "heading", level: 2, html });
  const text = (html: string): ArticleBlock => ({ type: "paragraph", html });
  const book: ArticleBlock = { type: "card", ref: "articolo/libro", props: {}, entries: [] };
  if (language === "it") return [
    { key: "recensione", name: "Recensione", blocks: [book, text("In due righe: di che libro si parla e perché leggerlo."), heading("La trama"), text("Racconta l'inizio, senza svelare il finale."), heading("Il giudizio"), text("Che cosa funziona, che cosa no, a chi lo consigli.")] },
    { key: "intervista", name: "Intervista", blocks: [text("Chi è la persona intervistata e perché sentirla adesso."), heading("La prima domanda"), text("La risposta."), heading("La seconda domanda"), text("La risposta.")] },
    { key: "comunicato", name: "Comunicato", blocks: [text("Chi, che cosa, quando, dove, in una frase."), heading("I dettagli"), text("Il programma e i nomi."), heading("Per informazioni"), text("Contatti e collegamenti.")] },
  ];
  return [
    { key: "recensione", name: "Review", blocks: [book, text("In two lines: which book, and why read it."), heading("The plot"), text("Tell the beginning, not the end."), heading("The verdict"), text("What works, what does not, who it is for.")] },
    { key: "intervista", name: "Interview", blocks: [text("Who the guest is, and why now."), heading("The first question"), text("The answer."), heading("The second question"), text("The answer.")] },
    { key: "comunicato", name: "Press release", blocks: [text("Who, what, when, where, in one sentence."), heading("The details"), text("The programme and the names."), heading("For information"), text("Contacts and links.")] },
  ];
}
