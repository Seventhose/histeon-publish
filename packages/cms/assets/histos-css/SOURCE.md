# Histeon CSS assets

These framework stylesheets and the recipe data are generated/source assets from Histeon at commit `acd6069a967fd191eb23ce35f8ea52d657920144`:

- `histos.css` from `plugin/assets/framework/histos.css` (SHA-256 `3472b69721affa752a13a2887bf74997890713453bb5538833cbcb6ce296372a`)
- `xb-tokens.css` from `plugin/assets/tokens/xb-tokens.css` (SHA-256 `ac254f72a149ec8a8e469741ff2fcc21b0f837bdc84406c54367adf7e604be25`)
- `article-components.json` from `plugin/assets/framework/article-components.json` (the writer blocks, doc 24)
- `recipes.json` from `plugin/src/Framework/HistosCss/Recipes.php::all()` at commit `359f47761c3a309ea29fd438c592331a49d0424f` (75 recipes)
- `acss-map.json` from `plugin/src/Framework/HistosCss/AcssImport.php` (`tokens()` and `classes()`) at commit `d094b9a6731a7bd01c2134d5fd2086b6d1ff89c8`: the Automatic.css names that have a Histeon CSS equivalent, used by prototypes with `framework: "acss"` (queue C1). `node scripts/check-acss-map.mjs /path/to/builder` checks that it still matches.
- `design-data.json` is the single declarative source for generator defaults, limits, color/scale tables and aliases. `npm run cms:design-data` generates the CMS TypeScript constant and `DesignData.php` in the isolated Histeon clone; `npm run cms:design-data:check` verifies that both generated outputs are current.

The Histeon CSS files are licensed GPL-3.0-or-later. Their generator is ported in `src/histos-design.ts`; its declarative inputs come from the shared source above. The stylesheet files preserve their generated upstream headers. `node build-histos-css-assets.mjs` embeds the checked-in files for the server build. The builder checkout they come from is not modified.
