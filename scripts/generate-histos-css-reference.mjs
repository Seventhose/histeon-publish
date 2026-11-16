import { execFileSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.resolve(process.env.HISTOS_BUILDER_ROOT ?? path.join(root, "../histos-cms-builder"));
const autoload = path.join(builder, "plugin/vendor/autoload.php");
await access(autoload);

const cases = [
  { name: "defaults", input: null },
  { name: "custom-brand-and-fluid-scales", input: { primary: "#e5533d", radius: 4, text_min: 15.5, space_max: 32, font_body: "Inter, sans-serif" } },
  {
    name: "minimum-boundaries",
    input: {
      primary: "oklch(0 0 360)", secondary: "#fff", accent: "#000", neutral: "rgb(0, 0, 0)",
      success: "oklch(20% 0.5 359)", warning: "rgb(255, 255, 255)", danger: "#123", info: "rgb(1 2 3)",
      text_min: 10, text_max: 10, text_ratio_min: 1, text_ratio_max: 1,
      space_min: 4, space_max: 4, space_ratio_min: 1, space_ratio_max: 1,
      viewport_min: 240, viewport_max: 600, radius: 0,
      width_content: 30, width_wide: 30, width_prose: 30,
      font_body: "Inter, sans-serif", font_heading: "'Playfair Display', serif", font_mono: "monospace",
    },
  },
  {
    name: "maximum-boundaries",
    input: {
      primary: "oklch(100% 0.8 720)", secondary: "rgb(999 0 0)", accent: "rgba(1, 2, 3, 0.5)", neutral: "oklch(1 0 180)",
      text_min: 32, text_max: 40, text_ratio_min: 2, text_ratio_max: 2,
      space_min: 64, space_max: 96, space_ratio_min: 2.5, space_ratio_max: 2.5,
      viewport_min: 1200, viewport_max: 3840, radius: 64,
      width_content: 160, width_wide: 200, width_prose: 120,
      font_body: "System UI, sans-serif", font_heading: "Georgia, serif", font_mono: "ui-monospace, monospace",
    },
  },
  {
    name: "colours-dark-system",
    input: {
      tertiary_on: 1, tertiary: "#7c3aed", warning_on: "0", brand_lightness_on: true, brand_lightness: 0.5, state_lightness_on: 1, state_lightness: 0.7,
      hover_shade: 700, dark_on: 1, scheme: "system", primary_dark: "oklch(75% 0.12 265)", info_dark: "",
      role_bg: "primary-50", role_text_muted: "auto", role_link: "accent-600", role_heading_dark: "tertiary-100", role_border_dark: "white",
    },
  },
  {
    name: "colours-dark-site-auto-contrast",
    input: { dark_on: 1, scheme: "dark", role_bg: "neutral-500", role_bg_dark: "neutral-400", role_surface: "warning", auto_contrast: 1, accent_on: 0 },
  },
  {
    name: "colours-roles-without-auto-contrast",
    input: { role_bg: "neutral-500", auto_contrast: 0, role_focus: "black", role_link_hover: "secondary", secondary_on: 0 },
  },
  {
    name: "typography-headings-and-text",
    input: {
      root_size: 87.5, heading_scale_on: 1, heading_min: 20, heading_max: 28, heading_ratio_min: 1.15, heading_ratio_max: 1.4,
      headings_on: 1, heading_font: "display", heading_weight: 600, heading_leading: 1.1, heading_tracking: -0.02, heading_case: "uppercase",
      heading_wrap: "pretty", heading_measure: 30, h1_weight: 900, h2_leading: 1.3, text_on: true, text_leading: 1.7, text_wrap: "balance",
      font_display: "'Playfair Display', serif", font_accent: "",
    },
  },
  {
    name: "typography-with-dark-theme",
    input: { headings_on: 1, h6_weight: 400, heading_tracking: 0.1, heading_font: "accent", font_accent: "Inter, sans-serif", dark_on: 1, scheme: "dark" },
  },
  {
    name: "space-and-layout",
    input: {
      section_multiplier_min: 0.75, section_multiplier_max: 1.5, section_padding: "l", gutter_min: 16, gutter_max: 32,
      container_gap: "xl", content_gap: "s", grid_gap: "l", grid_min: 18, grid_fill: "auto-fill", width_min: 360, header_min: 56, header_max: 96, scroll_offset_on: 1,
    },
  },
  {
    name: "shapes-buttons-links",
    input: {
      radius: 6, border_width: 2, border_style: "dashed", btn_pad_y: 0.6, btn_pad_x: 1.8, btn_radius: "full", btn_weight: 700, btn_leading: 1.1,
      btn_size: "s", btn_case: "uppercase", btn_tracking: 0.05, btn_border: 2, btn_min: 8, btn_full_mobile: 1, btn_full_below: 560,
      link_underline: "hover", link_thickness: 2, link_offset: 0.3, links_on: 1,
    },
  },
  {
    name: "forms-and-details",
    input: {
      field_pad_y: 0.5, field_pad_x: 1.2, field_radius: "full", field_bg: "surface-2", field_border: 2, field_focus_ring: 4, label_weight: 500, forms_on: 1,
      focus_on: 1, focus_width: 3, focus_offset: 1, smooth_scroll: 1, reduce_motion: 1, selection_on: 1, selection_shade: "300", quotes_on: 1,
      columns_min: 16, columns_gap: "xl", columns_rule: 1,
    },
  },
  {
    name: "motion-and-effects",
    input: { enter_range: 45, enter_distance: "2xl", enter_ease: "linear", hover_duration: 300, hover_lift: 8, hover_scale: 1.1 },
  },
  {
    name: "cards-and-icons",
    input: { card_pad: "m", card_gap: "s", card_radius: "xl", card_bg: "white", card_shadow: "none", card_border: 0, card_ratio: "4/3", icon_color: "accent", icon_stroke: 1.5, icon_box_shade: "50", list_icon_color: "success", list_icon_gap: "s" },
  },
  {
    name: "groups-of-variables-off",
    input: { print_alphas: 0, print_shadows: 0, print_buttons: 0, print_forms: 0, print_cards: 0, print_icons: 0, print_motion: 0, block_palette: 0, dark_on: 1, scheme: "system", primary: "#e5533d" },
  },
  {
    name: "forms-in-full",
    input: { forms_on: 1, field_size: "s", field_placeholder: "neutral-500", label_size: "s", help_size: "s", help_color: "text", field_invalid: "warning", field_valid: "info", check_style: "switch", check_size: 1.4, field_gap: "l" },
  },
  {
    name: "typography-steps-and-levels",
    input: { size_text_m_min: 17, size_text_m_max: 19, size_text_4xl_min: 40, size_text_4xl_max: 0, size_h1_min: 44, size_h1_max: 72, h2_color: "primary", h3_font: "mono", h4_case: "uppercase", h1_font: "display", font_display: "Georgia, serif", headings_on: 1 },
  },
  {
    name: "overlay-and-surfaces",
    input: { overlay_color: "primary", overlay_opacity: 0.35, overlay_blend: "multiply", role_named_1: "primary-900", surface_1_border: 1, surface_1_shadow: "m", role_named_2: "accent-100", role_named_3: "white", surface_3_shadow: "s" },
  },
  {
    name: "text-spacing-and-boxed",
    input: { flow_text: 1.2, flow_heading: 2, flow_after: 0.5, flow_list: 0.3, boxed_on: 1, boxed_width: 80, boxed_bg: "neutral-900", boxed_shadow: "xl" },
  },
  {
    name: "radius-ratio-dividers-grid-max",
    input: { radius: 10, radius_ratio: 1.6, divider_width: 2, divider_style: "dashed", divider_space: "l", grid_max: 3 },
  },
  {
    name: "class-groups-off",
    input: { classes_colors: 0, classes_buttons: 0, classes_motion: 0, classes_icons: 0, classes_cards: 0, classes_forms: 0 },
  },
  { name: "class-groups-motion-off", input: { classes_motion: 0 } },
  { name: "tokens-inline-text-steps-step-bar", input: { tokens_inline: 1, text_l_leading: 1.3, text_l_tracking: -0.01, text_l_measure: 40, text_l_case: "uppercase", text_xs_wrap: "pretty", forms_on: 1, step_height: 12, step_color: "accent", step_track: "surface-2" } },
  { name: "shadows-by-step", input: { shadow_s_y: 2, shadow_s_blur: 3, shadow_s_opacity: 0.5, shadow_2xl_y: 100, shadow_2xl_blur: 200, shadow_2xl_opacity: 1, tshadow_m_y: 0, tshadow_m_blur: 0, tshadow_m_opacity: 0 } },
  { name: "buttons-by-family-and-variant", input: { btn_info_on: 0, btn_warning_on: 0, btn_outline_on: 0, btn_dark_on: 0 } },
  { name: "list-symbol-and-external-links", input: { list_icon_symbol: "star", external_on: 1, external_host: "esempio.it", external_label: "(altro sito: 2)", external_place: "before" } },
  { name: "external-links-without-symbol", input: { external_on: 1, external_host: "sub.esempio-due.com", external_symbol: "none" } },
  { name: "external-links-without-domain", input: { external_on: 1 } },
  { name: "text-spacing-everywhere-and-section-grid", input: { flow_scope: "content", section_grid_on: 1 } },
  { name: "contrast-against-surfaces", input: { role_surface: "neutral-300", role_surface_2: "neutral-400", role_surface_dark: "neutral-600", dark_on: 1 } },
  { name: "contrast-no-shade-reads-on-all", input: { role_bg: "neutral-950", role_surface: "white", role_surface_2: "neutral-500", role_text: "auto" } },
  { name: "surface-gradients", input: { role_named_1: "primary-900", role_named_1_to: "accent-700", surface_1_angle: 45, role_named_2: "neutral-50", role_named_2_to: "neutral-500", role_named_3_to: "primary" } },
  { name: "variant-hover-and-surface-names", input: { btn_light_hover: "300", btn_dark_hover: "700", role_named_1: "primary-900", surface_1_name: "hero", surface_3_name: "nota-bene" } },
  { name: "effect-parameters", input: { enter_scale: 0.7, enter_blur: 20, exit_range: 60, hover_bright: 1.3, hover_fade: 0.5 } },
  { name: "smaller-options", input: { transition_ms: 300, heading_italic: 1, focus_style: "dashed", quote_width: 2, quote_color: "accent-300", quote_pad: "xl", quote_italic: 1, selection_text: "on-primary", divider_color: "primary", border_color: "text-muted", label_color: "text", legend_size: "l", field_focus_color: "accent", icon_box_pad: "m", icon_box_radius: "none", h1_tracking: -0.02, h2_measure: 30, h6_tracking: 0.1, headings_on: 1, quotes_on: 1, forms_on: 1, selection_on: 1, focus_on: 1 } },
  { name: "icons-card-title-overlays-wrap", input: { icon_xs: 0.5, icon_m: 2.5, icon_2xl: 8, card_title: "h2", overlay_2_color: "white", overlay_2_opacity: 0.25, overlay_3_color: "primary", overlay_3_opacity: 0.4, overlay_3_blend: "multiply", h1_wrap: "pretty", h3_wrap: "wrap", headings_on: 1 } },
  { name: "dark-hover-and-submit", input: { dark_on: 1, dark_hover_shade: "200", forms_on: 1, form_submit: "accent" } },
];

const payload = Buffer.from(JSON.stringify(cases)).toString("base64");
const php = `
require ${JSON.stringify(autoload)};
$cases = json_decode(base64_decode('${payload}'), true, 512, JSON_THROW_ON_ERROR);
$vectors = [];
foreach ($cases as $case) {
  $design = \\XB\\Framework\\HistosCss\\Design::validate($case['input']);
  $vectors[] = array(
    'name' => $case['name'], 'input' => $case['input'], 'design' => $design,
    'tokens' => \\XB\\Framework\\HistosCss\\Tokens::compute($design),
    'contrast' => \\XB\\Framework\\HistosCss\\Tokens::contrast($design),
    'css' => \\XB\\Framework\\HistosCss\\Tokens::css_changes($design),
    'sheet' => \\XB\\Framework\\HistosCss\\Tokens::sheet($design),
    'preview' => \\XB\\Framework\\HistosCss\\Tokens::preview_css($design),
    'classesOff' => \\XB\\Framework\\HistosCss\\Utilities::off_patterns($design),
    'classesSha' => hash('sha256', \\XB\\Framework\\HistosCss\\Utilities::filtered(\\XB\\Framework\\HistosCss\\Utilities::stylesheet(), $design)),
    'changed' => \\XB\\Framework\\HistosCss\\Design::changes($design),
  );
}
$custom = $vectors[1];
$out = array(
  'defaults' => \\XB\\Framework\\HistosCss\\Design::DEFAULTS,
  'defaultTokens' => $vectors[0]['tokens'], 'defaultContrast' => $vectors[0]['contrast'],
  'customDesign' => $custom['design'], 'customTokens' => $custom['tokens'],
  'customContrast' => $custom['contrast'], 'customCss' => $custom['css'],
  'vectors' => $vectors,
);
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), PHP_EOL;
`;
const output = execFileSync(process.env.PHP_BIN ?? "php", ["-r", php], { cwd: builder, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
JSON.parse(output);
await writeFile(path.join(root, "packages/cms/test/fixtures/histos-css-reference.json"), `${output.trimEnd()}\n`, "utf8");
process.stdout.write(`Aggiornato histos-css-reference.json dal generatore PHP di ${builder}.\n`);
