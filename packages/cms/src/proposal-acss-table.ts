/**
 * Voce 2 (prodotti dell'11 novembre 2026): le variabili di Automatic.css che `kit proposte` usa e che la tabella del
 * builder (`assets/histos-css/acss-map.json`, HISTOS_ACSS_MAP) non ha. Nome ACSS → token Histeon CSS, tutti e due senza
 * «--». La tabella intera di una proposta è quella del builder rovesciata più queste righe, che vincono.
 *
 * Una riga entra solo se il token Histeon fa lo stesso lavoro della variabile ACSS. Le variabili che restano fuori
 * (per esempio --base, --bg-dark, --text-light-muted) non si indovinano: restano nel :root del prototipo col loro
 * valore e l'utente le vede elencate nelle note della conversione.
 */
export const PROPOSAL_ACSS_EXTRA: Readonly<Record<string, string>> = {
  // Testo scuro su fondo chiaro e testo chiaro su fondo scuro.
  "text-dark": "xb-text",
  "text-light": "xb-white",
  // Raggi.
  radius: "xb-radius-m",
  "radius-circle": "xb-radius-full",
  "radius-50": "xb-radius-full",
  // Bordi.
  border: "xb-border",
  "border-width": "xb-border-width",
  "border-style": "xb-border-style",
  // Distanze di griglie e contenitori.
  "grid-gap": "xb-grid-gap",
  "container-gap": "xb-container-gap",
  "content-gap": "xb-content-gap",
  "header-height": "xb-header-height",
  // Messa a fuoco.
  "focus-width": "xb-focus-width",
  "focus-offset": "xb-focus-offset",
  // Ombre.
  "drop-shadow-1": "xb-drop-shadow-s",
  "drop-shadow-2": "xb-drop-shadow-m",
  "drop-shadow-3": "xb-drop-shadow-l",
  "text-shadow-1": "xb-text-shadow-s",
  "text-shadow-2": "xb-text-shadow-m",
  "text-shadow-3": "xb-text-shadow-l",
  // Titoli.
  "heading-font-weight": "xb-heading-weight",
  "heading-line-height": "xb-heading-leading",
  // Icone.
  "icon-size-xs": "xb-icon-xs",
  "icon-size-s": "xb-icon-s",
  "icon-size-m": "xb-icon-m",
  "icon-size-l": "xb-icon-l",
  "icon-size-xl": "xb-icon-xl",
  "icon-size-2xl": "xb-icon-2xl",
};
