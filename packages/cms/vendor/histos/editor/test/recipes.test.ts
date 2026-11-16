import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { recipeSource } from '../src/lib/cssActions.ts';
import { CSS_GROUPS, RECIPE_ALIASES, JS_RECIPES, cssGroups, jsPreviewDocument, jsRecipeCode, previewDocument, recipeMatches, resolveRecipe, sampleFor } from '../src/lib/recipes.ts';

const recipes = Object.fromEntries(CSS_GROUPS.flatMap((g) => g.names).map((n) => [n, `/* ${n} */ display: grid;`]));

function complete(text: string) {
  const state = EditorState.create({ doc: text });
  return recipeSource(() => recipes)(new CompletionContext(state, text.length, true)) as { options: Array<{ label: string; apply: string }> } | null;
}

describe('recipes panel', () => {
  it('groups each Histeon recipe once, and the site’s own in «Dal sito»', () => {
    const names = CSS_GROUPS.flatMap((g) => g.names);
    expect(new Set(names).size, 'no recipe in two groups').toBe(names.length);
    const groups = cssGroups({ ...recipes, 'acss-thing': 'x: y;' });
    expect(groups.at(-1)).toMatchObject({ id: 'site', names: ['acss-thing'] });
    expect(cssGroups({ centra: 'x' })).toEqual([expect.objectContaining({ id: 'layout', names: ['centra'] })]);
  });

  it('takes alternative names as aliases of the same Histeon recipe', () => {
    for (const target of Object.values(RECIPE_ALIASES)) expect(Object.hasOwn(recipes, target), target).toBe(true);
    expect(resolveRecipe('auto-grid', recipes)).toBe('griglia-auto');
    expect(resolveRecipe('griglia-auto', recipes)).toBe('griglia-auto');
    expect(resolveRecipe('niente', recipes)).toBeNull();
    expect(recipeMatches('griglia-auto', '', 'auto-grid'), 'the filter finds a recipe by an alternative name').toBe(true);
    expect(recipeMatches('centra', 'place-items', 'place')).toBe(true);
  });

  it('completes @name and ?name, alternative names included, only at the start of a declaration', () => {
    expect(complete('.x { @gri')?.options.map((o) => o.label)).toContain('@griglia-auto');
    const alias = complete('.x { ?auto-g');
    expect(alias?.options.map((o) => o.label)).toEqual(['?auto-grid']);
    expect(alias?.options[0]?.apply).toContain('griglia-auto');
    expect(complete('.x { color: @gri'), 'not inside a value').toBeNull();
    expect(complete('@media'), '@media is never a recipe').toBeNull();
  });

  it('previews with no script, and writes a JS recipe for the chosen class', () => {
    const doc = previewDocument(sampleFor('griglia-3', 'display: grid;'), '.r{display:grid}');
    expect(doc).toContain("default-src 'none'; style-src 'unsafe-inline'");
    expect(doc).not.toMatch(/<script/i);
    expect(sampleFor('tronca-righe', '')).toBe('text');
    for (const recipe of JS_RECIPES) {
      const code = jsRecipeCode(recipe, '.card');
      expect(code, recipe.name).not.toContain('{selector}');
      expect(code).toContain('.card');
      expect(() => new Function(code), `${recipe.name} is valid JavaScript`).not.toThrow();
      expect(jsPreviewDocument(recipe)).not.toMatch(/<script/i);
    }
  });
});
