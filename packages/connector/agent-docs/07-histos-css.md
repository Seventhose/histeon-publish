---
key: histos-css
title: Histeon CSS: token, parametri, classi e ricette
summary: Leggilo quando il sito o il prototipo usa Histeon CSS: quali token --xb-* scrivere, chi cambia i parametri del design, quando una classe utility va bene, cosa sono le ricette @nome.
---

# Histeon CSS

Histeon CSS è il framework CSS libero di Histeon. Ti dà tre cose:
- i **token** `--xb-*`: la tua tavolozza di valori;
- le **classi utility** `xb-*`: solo per eccezioni;
- le **ricette** `@nome`: scorciatoie dell'editor CSS.

Nasce da *Histeon Tokens*: nel builder il suo id resta `xb-tokens`, il nome mostrato è **Histeon CSS**.

## L'essenziale

1. Lo stile sta nel selettore del blocco BEM. I token sono i valori che ci scrivi dentro. Vedi l'argomento `stile`.
2. Spazi, testi, colori, raggi e ombre: sempre un token `--xb-*`. Mai un valore inventato (`17px`, `#3a7bd5`).
3. Con Histeon CSS attivo le variabili del framework **sono** i token `--xb-*`: usa solo quelli, non solo nei componenti.
4. Le classi `xb-*` non costruiscono layout, sezioni o componenti. Nel dubbio, scegli il blocco.
5. I parametri del design (colori, scale, caratteri): nel builder li cambia l'utente; nel prototipo li scrivi in `design` nel manifest. Mai valori sparsi al loro posto.
6. Una ricetta `@nome` si espande solo nell'editor CSS. Tu scrivi le dichiarazioni per esteso.

✅ Giusto (nel builder: `set-css .event-card '…'`, solo il corpo della regola; `(--tablet)` è un nome d'esempio, usa le media query con nome del `brief`):
```css
display: grid;
gap: var(--xb-space-s);
padding: var(--xb-space-m);
border-radius: var(--xb-radius-m);
background: var(--xb-surface);
color: var(--xb-text);
&__title { font-size: var(--xb-text-l); color: var(--xb-heading); }
&--featured { box-shadow: var(--xb-shadow-m); }
&:focus-visible { outline: 2px solid var(--xb-primary); outline-offset: 2px; }
@media (--tablet) { padding: var(--xb-space-s); }
```

❌ Sbagliato:
```html
<!-- catena di utility al posto di un blocco con il suo stile -->
<article class="xb-p-m xb-bg-surface xb-rounded-m xb-shadow-m xb-stack">…</article>
```
```css
padding: 23px;     /* valore inventato: var(--xb-space-m) */
color: #3a7bd5;    /* colore inventato: un token di colore */
@centra            /* ricetta scritta con set-css: non si espande */
```

## I token `--xb-*`

I nomi esatti sono nell'elenco completo qui sotto. Qui trovi cosa significano.
- **Testo e spazi fluidi:** ogni passo delle scale (`--xb-text-m`, `--xb-space-m`…) è un `clamp()` fra due larghezze dello schermo. `--xb-h1` … `--xb-h6` sono le misure dei titoli.
- **Attenzione:** `--xb-text` e `--xb-text-muted` sono colori; `--xb-text-s`, `--xb-text-m`, `--xb-text-l`… sono misure del testo.
- **Alias:** `--xb-text-xxl` e `--xb-space-xxl` valgono come `2xl`.
- **Famiglie di colore** (`primary`, `secondary`…): per ognuna il colore di base (`--xb-primary`), le sfumature (`--xb-primary-50` … `--xb-primary-950`) e il testo leggibile sopra quel colore (`--xb-on-primary`).
- **`-light` e `-dark`:** `--xb-primary-light` e `--xb-primary-dark` sono le sfumature 100 e 800. Non tutte le famiglie li hanno: controlla l'elenco.
- **Semantici:** per esempio `--xb-bg`, `--xb-surface`, `--xb-text`, `--xb-heading`, `--xb-border`, `--xb-link`.

### Come sceglierli
1. Per sfondi, testi, titoli, bordi e link usa i semantici. Con la classe `xb-scheme-dark` puntano da soli alle sfumature scure.
2. Su uno sfondo di famiglia, il testo è il suo `--xb-on-*`: su `--xb-primary` scrivi `color: var(--xb-on-primary)`.
3. Testo e spazi sono già fluidi: spesso non ti serve una `@media` per ridurli.
4. Usa solo nomi dell'elenco qui sotto. Un `var()` con un nome che non esiste non dà nessun valore.

### Elenco completo

{{histos-css:tokens}}

## I parametri del design

Pochi valori generano tutti i token. Senza parametri valgono i predefiniti.

| Gruppo | Parametri | Predefinito |
|---|---|---|
| Colori | `primary`, `secondary`, `tertiary`, `accent`, `neutral`, `success`, `warning`, `danger`, `info` | colori in esadecimale, `rgb()` o `oklch()` |
| Famiglie attive | `secondary_on`, `tertiary_on`, `accent_on`, `success_on`, `warning_on`, `danger_on`, `info_on` (0 o 1): una famiglia spenta non ha token | 1; `tertiary_on` 0 |
| Luminosità unica | `brand_lightness_on` e `brand_lightness` (famiglie del marchio), `state_lightness_on` e `state_lightness` (stati), 0,30-0,85 | 0, 0,62 |
| Passaggio | `hover_shade`: `"400"` … `"800"`, la sfumatura di `--xb-<famiglia>-hover` | `"600"` |
| Ruoli | `role_bg`, `role_surface`, `role_surface_2`, `role_text`, `role_text_muted`, `role_heading`, `role_border`, `role_link`, `role_link_hover`, `role_focus`, e gli stessi con `_dark`: `auto`, `white`, `black`, una famiglia o `famiglia-sfumatura` (`primary-700`); `auto_contrast` (0 o 1) sposta i testi automatici sulla sfumatura che si legge | `auto`, 1 |
| Tema scuro | `dark_on` (0 o 1), `scheme` (`light`, `dark`, `system`), `dark_hover_shade` (200-500), `primary_dark` … `info_dark` (un colore, o `""` per la sfumatura 400) | 0, `light`, `""` |
| Testo | `text_min`, `text_max` (px del passo `m`), `text_ratio_min`, `text_ratio_max` | 16, 18, 1.2, 1.25 |
| Spazi | `space_min`, `space_max` (px del passo `m`), `space_ratio_min`, `space_ratio_max` | 16, 24, 1.5, 1.6 |
| Viewport | `viewport_min`, `viewport_max` (px) | 360, 1440 |
| Forme | `radius` (px del passo `m`) | 8 |
| Larghezze | `width_content`, `width_wide` (rem), `width_prose` (ch) | 72, 90, 65 |
| Caratteri | `font_body`, `font_heading`, `font_mono`; `font_accent`, `font_display` (facoltativi) | pile di sistema; `""` |
| Titoli | `heading_scale_on` con `heading_min`, `heading_max`, `heading_ratio_min`, `heading_ratio_max` (scala propria di `--xb-h1 … h6`); `heading_font`, `heading_weight`, `heading_leading`, `heading_tracking`, `heading_case`, `heading_wrap`, `heading_measure`; per livello `h1_weight` … `h6_leading` (0 = come tutti); `headings_on` stila anche gli elementi `h1 … h6` | spenti; 700, 1.15, `balance` |
| Misure e livelli | `size_text_<passo>_min`, `size_text_<passo>_max`, `size_h<n>_min`, `size_h<n>_max` (px, 0 = la scala); `h<n>_color`, `h<n>_font`, `h<n>_case` (`auto` = come tutti i titoli) | 0; `auto` |
| Testo | `text_on` (stila `body` e i paragrafi), `text_leading`, `text_wrap`; `root_size` (% della radice) | spento, 1.6, `pretty`, 100 |
| Spaziatura e riquadro | `flow_text`, `flow_heading`, `flow_after`, `flow_list` (em, per `xb-prose`); `boxed_on`, `boxed_width`, `boxed_bg`, `boxed_shadow` | 1, 1.6, 0, 0; 0, 90, `neutral-100`, `m` |
| Spazi e layout | `section_multiplier_min`, `section_multiplier_max`, `section_padding`, `gutter_min`, `gutter_max`, `container_gap`, `content_gap`, `grid_gap`, `grid_min`, `grid_fill`, `width_min`, `header_min`, `header_max`, `scroll_offset_on`. La griglia dei contenuti: classe `xb-content-grid`, figli `xb-wide`, `xb-full`, `xb-narrow` | 1, 1, `m`, 0, 0, `l`, `m`, `m`, 14, `auto-fit`, 320, 64, 80, 0 |
| Raggi, divisori, griglia | `radius_ratio` (0 = raggi di partenza); `divider_width`, `divider_style`, `divider_space` (classe `xb-divider`); `grid_max` (0 = nessun limite) | 0; 1, `solid`, `m`; 0 |
| Bordo, pulsanti, link | `border_width`, `border_style`; `btn_pad_y`, `btn_pad_x`, `btn_radius`, `btn_weight`, `btn_leading`, `btn_size`, `btn_case`, `btn_tracking`, `btn_border`, `btn_min`, `btn_full_mobile`, `btn_full_below`; `link_underline`, `link_thickness`, `link_offset`, `links_on`. Ogni famiglia ha le classi `xb-btn-<famiglia>`, `-outline`, `-light`, `-dark`; misure `xb-btn-xs` … `xb-btn-xl` | 1, `solid`; 0.75, 1.4, `m`, 600, 1.2, `inherit`, `none`, 0, 0, 0, 0, 480; `always`, 0, 0.2, 0 |
| Moduli e dettagli | `forms_on`, `field_pad_y`, `field_pad_x`, `field_radius`, `field_bg`, `field_border`, `field_focus_ring`, `label_weight`, `field_size`, `label_size`, `field_placeholder`, `help_size`, `help_color`, `field_invalid`, `field_valid`, `check_style`, `check_size`, `field_gap`, `form_submit`; `focus_on`, `focus_width`, `focus_offset`, `smooth_scroll`, `reduce_motion`, `selection_on`, `selection_shade`, `quotes_on`, `columns_min`, `columns_gap`, `columns_rule` (classe `xb-columns`) | spenti; 0.65, 0.9, `m`, `bg`, 0, 3, 600; 2, 2, 200, 20, `l` |
| Sovrapposizioni e superfici | `overlay_color`, `overlay_opacity`, `overlay_blend` (classi `xb-overlay`, `xb-overlay-gradient`); `role_named_1`…`3`, `role_named_<n>_to` (fine del gradiente), `surface_<n>_angle`, `surface_<n>_name` (classe `xb-surface-<nome>`), `btn_light_hover`, `btn_dark_hover`, `surface_<n>_border`, `surface_<n>_shadow` (classi `xb-surface-1`…`3`) | `black`, 0.5, `normal`; `auto`, 0, `none` |
| Card e icone | `card_pad`, `card_gap`, `card_radius`, `card_bg`, `card_shadow`, `card_border`, `card_ratio`; `icon_color`, `icon_stroke`, `icon_box_shade`, `list_icon_color`, `list_icon_gap`. Classi `xb-card-media`, `xb-card-body`, `xb-radius-inner`, `xb-icon`, `xb-icon-<misura>`, `xb-icon-boxed`, `xb-list-icon` | `l`, `m`, `l`, `surface`, `s`, 1, `16/9`; `currentColor`, 2, 100, `primary`, `xs` |
| Movimento ed effetti | `enter_range`, `enter_distance`, `enter_ease`, `hover_duration`, `hover_lift`, `hover_scale`, `enter_scale`, `enter_blur`, `exit_range`, `hover_bright`, `hover_fade`. Classi `xb-enter-<effetto>` e `xb-exit-<effetto>` (fade, up, down, left, right, grow, shrink, blur) legate allo scorrimento, `xb-hover-<effetto>` (lift, shadow, glow, scale, bright, fade, underline); ferme con `prefers-reduced-motion` | 30, `l`, `ease-out`, 150, 4, 1.04 |
| Passi, ombre, pulsanti | `text_<passo>_leading`, `_tracking`, `_measure`, `_case`, `_wrap` (stile di `xb-text-<passo>`); `shadow_<s…2xl>_y`, `_blur`, `_opacity` e `tshadow_<s,m,l>_…`; `btn_<famiglia>_on`, `btn_outline_on`, `btn_light_on`, `btn_dark_on` | 0, `auto`; quelle di partenza; 1 |
| Link, liste, moduli, spazi | `external_on`, `external_host` (dominio del sito, serve), `external_label`, `external_symbol`, `external_place`; `list_icon_symbol`; `step_height`, `step_color`, `step_track`; `flow_scope` (`prose`, `content`), `section_grid_on`; `tokens_inline` (solo WordPress) | 0, vuoto, `(sito esterno)`, `arrow`, `after`; `check`; 8, `primary`, `neutral-200`; `prose`, 0; 0 |
| Opzioni minori | `transition_ms`, `heading_italic`, `h<n>_tracking`, `h<n>_measure`, `focus_style`, `quote_width`, `quote_color`, `quote_pad`, `quote_italic`, `selection_text`, `divider_color`, `border_color`, `label_color`, `legend_size`, `field_focus_color`, `icon_box_pad`, `icon_box_radius` | 150, 0, 0, 0, `solid`, 4, `primary-300`, `m`, 0, `text`, `border`, `border`, `heading`, `inherit`, `focus`, `xs`, `full` |
| Icone, card, sovrapposizioni | `icon_xs`…`icon_2xl`; `card_title`, classe `xb-card-title`; `overlay_2_color`, `overlay_2_opacity`, `overlay_2_blend`, `overlay_3_color`, `overlay_3_opacity`, `overlay_3_blend`, classi `xb-overlay-2`, `xb-overlay-3`; `h<n>_wrap` | 0,75…3; `h4`; `black`, 0.5, `normal`; `auto` |
| Avanzate | `print_alphas`, `print_shadows`, `print_buttons`, `print_forms`, `print_cards`, `print_icons`, `print_motion`: a 0 il gruppo di variabili non si stampa (non usarle); `block_palette`; `classes_colors`, `classes_buttons`, `classes_motion`, `classes_icons`, `classes_cards`, `classes_forms`: a 0 quelle classi non si stampano (non usarle) | tutti 1 |

Ogni valore passa un controllo stretto: numeri entro limiti, colori validi, pile di caratteri con soli lettere, cifre, spazi, virgole, trattini e virgolette bilanciate: nomi di famiglie, anche con spazi, e famiglie generiche, per esempio `"Playfair Display", Georgia, serif`.

- **Nel builder (connettore xb):** i parametri stanno nel documento `settings` (chiave `design`), con versioni, release e ripristino. Li cambia l'utente nel pannello Histeon CSS (voce **Histeon CSS** della barra di amministrazione, oppure Alt+Maiusc+H) o nel pannello Design system. Il connettore xb non ha uno strumento per cambiarli: se servono colori o caratteri diversi, proponilo all'utente.
- **In Histeon Publish (prototipo, connettore hp):** scrivi i parametri in `design` nel manifest, con gli stessi nomi: `"design": { "primary": "#c83c28" }`. Sono validati come quelli salvati dall'editor; quelli assenti restano predefiniti. Palette e caratteri vanno lì, non in valori sparsi nel CSS.

## Le classi utility `xb-*`

- Tutte hanno il prefisso `xb-` e **nessun doppio trattino**: `xb-grid-3`, mai `xb-grid--3`. Altri framework stilizzano `[class*="btn--"]` o `[class*="grid--"]`, e un sito che arriva da loro ne conserva le regole.
- Non stilizzano gli elementi nudi (`h1`, `p`): agiscono solo dove metti la classe.
- Nel builder, in pagina arrivano solo le regole delle classi presenti (CSS su richiesta).

Quando usarle:
- **Nel builder (connettore xb):** solo per una regolazione puntuale dentro un contenuto editoriale, per esempio un margine in più in un testo, quando creare un blocco sarebbe eccessivo. Mai per layout, componenti o sezioni: lì serve un blocco BEM con i token.
- **In Histeon Publish (prototipo, connettore hp):** nessuna utility. Lo chiede la lista «Prima di dire fatto» del manuale del prototipo (`hp_manual`): controllalo tu prima di consegnare.

```html
<!-- ✅ builder: eccezione puntuale in un testo -->
<p class="xb-mt-l">Nota finale dell'articolo.</p>
<!-- ❌ builder e prototipo: una sezione costruita con le utility -->
<section class="xb-section xb-bg-primary xb-grid xb-grid-3 xb-gap-m">…</section>
```

### Elenco completo

{{histos-css:classes}}

## Le ricette `@nome`

- Una ricetta è un pezzo di CSS con un nome. Nel pannello CSS del builder si scrive `@` più il nome (o `?` più il nome), all'inizio di una dichiarazione, e l'editor la espande. Alcuni nomi alternativi valgono come alias della ricetta Histeon che fa la stessa cosa (`?auto-grid` è `@griglia-auto`).
- Il pannello **Ricette** del builder le mostra tutte come pulsanti, con un'anteprima sul campione e sull'elemento selezionato prima di applicarle, e ha anche ricette JavaScript per il modulo del documento.
- Le ricette di Histeon CSS usano token `--xb-*` con un valore di riserva: funzionano con qualsiasi framework.
- Un sito può avere anche ricette sue, importate dal framework che usava prima. Stanno accanto a queste; a parità di nome vince quella del sito.
- Ogni ricetta passa un controllo: nome semplice, niente markup, graffe bilanciate, al massimo 4 KB.

**Per te:** la ricetta è un completamento dell'editor, non una regola CSS. Con `set-css` (connettore xb) e nel file del prototipo (connettore hp) `@nome` non si espande: scrivi le dichiarazioni vere.

```css
/* ❌ */ @centra
/* ✅ */ display: grid; place-items: center;
```

### Nomi delle ricette

{{histos-css:recipes}}

## In dettaglio

### Nel builder (connettore xb)
- `brief` (`xb_getBrief`) ti dice il framework attivo e i token `--xb-*` disponibili. `framework` (`xb_getFramework`) elenca variabili e classi. Usa i nomi esatti che trovi lì.
- I token valgono anche con Core Framework o Automatic.css: Histeon li collega alle variabili di quel framework, solo per quelle che esistono davvero. Vedi gli argomenti `core-framework` e `acss`.
- Una richiesta «Crea una sezione» dal pannello ✦ (la leggi con `next-task`): con Histeon CSS attivo, solo token `--xb-*`.
- `save` salva in sviluppo. Parametri, token e framework vanno online solo con una release, che fa l'utente.

### In Histeon Publish (prototipo, connettore hp)
- `"framework": "histos-css"` è il valore predefinito del manifest: gli stili possono usare i token `--xb-*`.
- Il controllo (`hp_check_prototype`) segnala ogni `var(--nome)` senza valore di riserva che nessun foglio definisce. Correggilo con un token `--xb-*` o con un valore di riserva: `var(--nome, 1rem)`.
- I token `--xb-*` valgono anche quando il sito WordPress di destinazione usa ACSS o Core Framework.
- Nel prototipo la regola è intera, con il selettore, in `<style data-histos="selectors">`. Vedi l'argomento `prototipi`.

```css
/* ✅ prototipo, dentro <style data-histos="selectors"> */
.event-card {
  padding: var(--xb-space-m);
  &__title { font-size: var(--xb-text-l); }
}
```
