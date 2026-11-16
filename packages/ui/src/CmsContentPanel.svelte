<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./lib/api.js";
  import { plural, stateLabel, translate, type Language } from "./lib/i18n.js";

  type FieldType = "text" | "rich-text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "enum" | "url" | "asset" | "relation";
  interface CmsField { key: string; label: string; type: FieldType; required: boolean; public: boolean; multiple: boolean; options?: string[]; targetType?: string }
  interface CmsType { id: string; key: string; label: string; fields: CmsField[]; singleTemplateRef: string | null; archiveTemplateRef: string | null; public?: boolean; headRevision: string }
  interface CmsTemplate { ref: string; title: string; hasDefaultSlot: boolean }
  interface CmsTerm { id: string; alias: number; taxonomyKey: string; slug: string; label: string; parentAlias: number | null; count: number; headRevision: string }
  interface CmsTaxonomy { id: string; key: string; label: string; types: string[]; headRevision: string }
  interface CmsRecord { id: string; typeKey: string; title: string; slug: string; locale: string; status: "draft" | "published" | "archived"; excerpt: string; order: number; values: Record<string, unknown>; terms: Record<string, CmsTerm[]>; headRevision: string }
  interface RelationOption { id: string; title: string; slug: string; locale: string; status?: "draft" | "published" | "archived" }
  interface Asset { id: string; filename: string }
  type CmsFilter = { and: CmsFilter[] } | { or: CmsFilter[] } | { taxonomyKey: string; termIds: string[]; operator: "IN" | "NOT IN" | "AND" } | { field: string; op: "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte" | "contains" | "exists"; value?: unknown };
  /** A record as the query returns it: its public fields by key (relations and media are objects). */
  interface CmsQueryPreviewItem { title: string; url: string; fields: Record<string, unknown> }
  interface QueryPreset { key: string; label: string; typeKey: string; limit: number; offset: number; orderBy: string; order: "asc" | "desc"; filter?: CmsFilter; headRevision: string }
  interface FieldDraft { key: string; label: string; type: FieldType; required: boolean; public: boolean; multiple: boolean; optionsText: string; targetType: string }
  interface CmsFieldPath { path: string; label: string; field: CmsField }

  const typeKeyPattern = "[a-z][a-z0-9_\\-]{0,62}";
  const fieldKeyPattern = "[a-z][a-z0-9_]{0,62}";
  const queryKeyPattern = "[A-Za-z_][A-Za-z0-9_]{0,63}";

  let { projectId, language = "it", locale, focusType = "", onChanged, selecting = false, selectedForTrash = [], onTrashSelectionChange, trashSelectionLabel }: {
    projectId: string;
    /** The interface language (E13): every text of the panel follows it. */
    language?: Language;
    /** The project's current locale, from the project settings (new records start in it). */
    locale?: string;
    /** The type to open on, for the site administration's section of that type. */
    focusType?: string;
    onChanged?: () => void;
    /** The page's "Seleziona" mode (E14): the boxes for the Cestino appear only then. */
    selecting?: boolean;
    selectedForTrash?: string[];
    onTrashSelectionChange?: (id: string, checked: boolean) => void;
    trashSelectionLabel?: (label: string) => string;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  /** A count with its noun, singular or plural by the language's rules ("1 campo", "2 campi"). */
  const tp = (key: string, n: number, values: Record<string, string | number> = {}) => plural(language, key, n, values);
  /** The shared name of a record status ("Bozza", "Nel sito", "Archiviato"), not its raw value. */
  const statusLabel = (status: string) => stateLabel(language, status).label;
  let types = $state<CmsType[]>([]);
  let templates = $state<CmsTemplate[]>([]);
  let selectedTypeKey = $state("");
  let records = $state<CmsRecord[]>([]);
  let recordsTotal = $state(0);
  let recordsOffset = $state(0);
  let recordSearch = $state("");
  let recordsLoading = $state(false);
  let assets = $state<Asset[]>([]);
  let relatedRecords = $state<Record<string, CmsRecord[]>>({});
  let relationSearch = $state<Record<string, string>>({});
  let relationSearchResults = $state<Record<string, RelationOption[]>>({});
  let relationSearchTotals = $state<Record<string, number>>({});
  let relationSearchLoading = $state<Record<string, boolean>>({});
  let relationSelections = $state<Record<string, RelationOption[]>>({});
  let presets = $state<QueryPreset[]>([]);
  let taxonomies = $state<CmsTaxonomy[]>([]);
  let taxonomyTerms = $state<Record<string, CmsTerm[]>>({});
  let recordTerms = $state<Record<string, number[]>>({});
  let creatingTaxonomy = $state(false);
  let taxonomyLabel = $state("");
  let taxonomyKey = $state("");
  let taxonomyTypes = $state<string[]>([]);
  let selectedTaxonomyKey = $state("");
  let termLabel = $state("");
  let termSlug = $state("");
  let selectedRecordId = $state("");
  let selectedRecord = $state<CmsRecord | null>(null);
  let recordTitle = $state("");
  let recordSlug = $state("");
  let recordStatus = $state<"draft" | "published" | "archived">("draft");
  let recordLocale = $state("it-IT");
  let loadedLocale = $state("it-IT");
  // The parent's value wins: the settings can change the locale while this panel stays open.
  const projectLocale = $derived(locale ?? loadedLocale);
  let recordExcerpt = $state("");
  let recordValues = $state<Record<string, unknown>>({});
  let creatingType = $state(false);
  let editingType = $state(false);
  let typeKey = $state("");
  let typeLabel = $state("");
  let singleTemplateRef = $state("");
  let archiveTemplateRef = $state("");
  /** Doc 23 item 122: pages of its own (single and archive), or shown only by loops. */
  let typePublic = $state(true);
  let fields = $state<FieldDraft[]>([]);
  let queryKey = $state("");
  let queryLabel = $state("");
  let queryLimit = $state(10);
  let queryOffset = $state(0);
  let queryOrder = $state<"asc" | "desc">("desc");
  let queryOrderBy = $state("publishedAt");
  let queryFilterMode = $state<"none" | "field" | "taxonomy">("none");
  let queryFilterField = $state("");
  let queryFilterOperator = $state("eq");
  let queryFilterValue = $state("");
  let queryRelationSearch = $state("");
  let queryRelationOptions = $state<RelationOption[]>([]);
  let queryRelationLoading = $state(false);
  let queryFilterTaxonomy = $state("");
  let queryFilterTaxonomyOperator = $state<"IN" | "NOT IN" | "AND">("IN");
  let queryFilterTerms = $state<string[]>([]);
  let querySaving = $state(false);
  let editingQuery = $state(false);
  let previewItems = $state<CmsQueryPreviewItem[]>([]);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  const selectedType = $derived(types.find((item) => item.key === selectedTypeKey) ?? null);
  const recordTaxonomies = $derived(taxonomies.filter((item) => item.types.includes(selectedTypeKey)));
  const queryFilterPaths = $derived.by(() => {
    const result: CmsFieldPath[] = [];
    const visit = (typeKey: string, path: string[], labels: string[], relationDepth: number): void => {
      const type = types.find((item) => item.key === typeKey);
      if (!type) return;
      for (const field of type.fields) {
        if (!field.public) continue;
        const nextPath = [...path, field.key];
        const nextLabels = [...labels, field.label];
        if (field.type === "relation") {
          result.push({ path: nextPath.join("."), label: t("cms.content.relationSuffix", { label: nextLabels.join(" → ") }), field });
          if (relationDepth < 3 && field.targetType) visit(field.targetType, nextPath, nextLabels, relationDepth + 1);
        } else if (!field.multiple && !["asset", "rich-text"].includes(field.type)) {
          result.push({ path: nextPath.join("."), label: nextLabels.join(" → "), field });
        }
      }
    };
    if (selectedTypeKey) visit(selectedTypeKey, [], [], 0);
    return result;
  });
  const queryField = $derived(queryFilterPaths.find((entry) => entry.path === queryFilterField)?.field ?? null);
  const recordPageSize = 50;

  onMount(() => { void reload().catch((cause) => { error = cause instanceof Error ? cause.message : t("cms.content.error.load"); }); });

  async function reload(): Promise<void> {
    error = "";
    const [typeResult, project, queryResult, taxonomyResult] = await Promise.all([
      api<{ types: CmsType[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/types`),
      api<{ assets: Asset[]; templates: CmsTemplate[]; renderSettings: { locale: string } }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}`),
      api<{ presets: QueryPreset[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/query-presets`),
      api<{ taxonomies: CmsTaxonomy[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/taxonomies`),
    ]);
    types = typeResult.types;
    assets = project.assets;
    templates = project.templates.filter((template) => template.hasDefaultSlot);
    loadedLocale = project.renderSettings.locale;
    presets = queryResult.presets;
    taxonomies = taxonomyResult.taxonomies;
    const taxonomyDetails = await Promise.all(taxonomies.map(async (taxonomy) => [taxonomy.key, (await api<{ terms: CmsTerm[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/taxonomies/${encodeURIComponent(taxonomy.key)}`)).terms] as const));
    taxonomyTerms = Object.fromEntries(taxonomyDetails);
    if (!taxonomies.some((item) => item.key === selectedTaxonomyKey)) selectedTaxonomyKey = taxonomies[0]?.key ?? "";
    if (focusType && types.some((item) => item.key === focusType)) selectedTypeKey = focusType;
    if (!types.some((item) => item.key === selectedTypeKey)) selectedTypeKey = types[0]?.key ?? "";
    await loadRecords();
  }

  async function loadRecords(): Promise<void> {
    if (!selectedTypeKey) { records = []; recordsTotal = 0; relatedRecords = {}; return; }
    recordsLoading = true;
    try {
      const params = new URLSearchParams({ type: selectedTypeKey, status: "any", limit: String(recordPageSize), offset: String(recordsOffset) });
      if (recordSearch.trim()) params.set("q", recordSearch.trim());
      const result = await api<{ items: CmsRecord[]; total: number }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records?${params}`);
      records = result.items;
      recordsTotal = result.total;
      const targets = [...new Set((selectedType?.fields ?? []).filter((field) => field.type === "relation" && field.targetType).map((field) => field.targetType!))];
      const loaded = await Promise.all(targets.map(async (key) => [key, (await api<{ items: CmsRecord[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records?type=${encodeURIComponent(key)}&status=any&limit=100&offset=0`)).items] as const));
      relatedRecords = Object.fromEntries(loaded);
    } finally { recordsLoading = false; }
  }

  async function refreshRecords(offset = recordsOffset): Promise<void> {
    recordsOffset = Math.max(0, offset);
    try { await loadRecords(); }
    catch (cause) { recordsLoading = false; error = cause instanceof Error ? cause.message : t("cms.content.error.loadRecords"); }
  }

  function relatedOptions(field: CmsField): RelationOption[] {
    const targetType = field.targetType ?? "";
    const defaults = (relatedRecords[targetType] ?? []).map(({ id, title, slug, locale, status }) => ({ id, title, slug, locale, status }));
    const searched = relationSearchResults[field.key] ?? [];
    const selected = relationSelections[field.key] ?? [];
    return [...new Map([...defaults, ...searched, ...selected].map((item) => [item.id, item])).values()];
  }

  function recordPublicPath(record: Pick<CmsRecord, "slug" | "locale">, typeKey: string): string {
    const locale = record.locale.toLowerCase();
    const defaultLocale = projectLocale.toLowerCase();
    const prefix = locale === defaultLocale ? "" : `/${locale}`;
    return `${prefix}/${typeKey}/${record.slug}/`;
  }

  async function searchRelatedRecords(field: CmsField): Promise<void> {
    if (!field.targetType) return;
    relationSearchLoading = { ...relationSearchLoading, [field.key]: true };
    error = "";
    try {
      const query = relationSearch[field.key]?.trim() ?? "";
      const params = new URLSearchParams({ type: field.targetType, status: "any", limit: "100", offset: "0" });
      if (query) params.set("q", query);
      const result = await api<{ items: CmsRecord[]; total: number }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records?${params}`);
      const selectedValue = recordValues[field.key];
      const selectedIds = (field.multiple && Array.isArray(selectedValue) ? selectedValue : selectedValue ? [selectedValue] : [])
        .flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []);
      const known = new Map(relationSelections[field.key]?.map((item) => [item.id, item]) ?? []);
      for (const item of result.items) known.set(item.id, item);
      const missing = selectedIds.filter((id) => !known.has(id));
      const selected = await Promise.all(missing.map(async (id) => {
        const response = await api<{ record: CmsRecord }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records/${encodeURIComponent(id)}`);
        return response.record;
      }));
      for (const item of selected) known.set(item.id, item);
      relationSearchResults = { ...relationSearchResults, [field.key]: [...known.values()] };
      relationSearchTotals = { ...relationSearchTotals, [field.key]: result.total };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t("cms.content.error.searchRelated");
    } finally { relationSearchLoading = { ...relationSearchLoading, [field.key]: false }; }
  }

  function searchRecordList(): void { void refreshRecords(0); }

  function chooseType(typeKey: string): void {
    selectedTypeKey = typeKey;
    recordSearch = "";
    recordsOffset = 0;
    relationSearchResults = {};
    relationSearchTotals = {};
    resetRecord();
    void refreshRecords(0);
  }

  function defaultValue(field: CmsField): unknown {
    if (field.type === "boolean") return false;
    if (field.multiple) return [];
    return "";
  }

  function resetRecord(): void {
    selectedRecordId = "";
    selectedRecord = null;
    recordTitle = "";
    recordSlug = "";
    recordStatus = "draft";
    recordLocale = projectLocale;
    recordExcerpt = "";
    recordValues = Object.fromEntries((selectedType?.fields ?? []).map((field) => [field.key, defaultValue(field)]));
    relationSelections = {};
    recordTerms = Object.fromEntries(recordTaxonomies.map((taxonomy) => [taxonomy.key, []]));
  }

  function editRecord(record: CmsRecord): void {
    selectedRecordId = record.id;
    selectedRecord = record;
    recordTitle = record.title;
    recordSlug = record.slug;
    recordStatus = record.status;
    recordLocale = record.locale;
    recordExcerpt = record.excerpt;
    recordValues = Object.fromEntries((selectedType?.fields ?? []).map((field) => [field.key, record.values[field.key] ?? defaultValue(field)]));
    relationSelections = Object.fromEntries((selectedType?.fields ?? []).flatMap((field) => {
      if (field.type !== "relation") return [];
      const value = record.values[field.key];
      const refs = field.multiple && Array.isArray(value) ? value : value ? [value] : [];
      return [[field.key, refs.flatMap((item): RelationOption[] => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { title?: unknown }).title === "string" && typeof (item as { slug?: unknown }).slug === "string" && typeof (item as { locale?: unknown }).locale === "string" ? [{ id: (item as { id: string }).id, title: (item as { title: string }).title, slug: (item as { slug: string }).slug, locale: (item as { locale: string }).locale }] : [])]];
    }));
    recordTerms = Object.fromEntries(recordTaxonomies.map((taxonomy) => [taxonomy.key, (record.terms?.[taxonomy.key] ?? []).map((term) => term.alias)]));
  }

  function setRecordTerms(taxonomyKey: string, event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    recordTerms = { ...recordTerms, [taxonomyKey]: [...select.selectedOptions].map((option) => Number(option.value)).filter(Number.isSafeInteger) };
  }

  async function saveTaxonomy(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true; error = ""; notice = "";
    try {
      const result = await api<{ taxonomy: CmsTaxonomy }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/taxonomies`, { method: "POST", body: JSON.stringify({ key: taxonomyKey, label: taxonomyLabel, types: taxonomyTypes }) });
      taxonomies = [...taxonomies, result.taxonomy].sort((a, b) => a.label.localeCompare(b.label));
      taxonomyTerms = { ...taxonomyTerms, [result.taxonomy.key]: [] };
      selectedTaxonomyKey = result.taxonomy.key;
      creatingTaxonomy = false; taxonomyLabel = ""; taxonomyKey = ""; taxonomyTypes = [];
      notice = t("cms.content.notice.taxonomyCreated");
      resetRecord(); onChanged?.();
    } catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.createTaxonomy"); }
    finally { busy = false; }
  }

  async function saveTerm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!selectedTaxonomyKey) return;
    busy = true; error = ""; notice = "";
    try {
      const result = await api<{ term: CmsTerm }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/taxonomies/${encodeURIComponent(selectedTaxonomyKey)}/terms`, { method: "POST", body: JSON.stringify({ slug: termSlug || keyFromLabel(termLabel), label: termLabel }) });
      taxonomyTerms = { ...taxonomyTerms, [selectedTaxonomyKey]: [...(taxonomyTerms[selectedTaxonomyKey] ?? []), result.term].sort((a, b) => a.label.localeCompare(b.label)) };
      termLabel = ""; termSlug = ""; notice = t("cms.content.notice.termCreated");
      onChanged?.();
    } catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.createTerm"); }
    finally { busy = false; }
  }

  function fieldInputValue(field: CmsField): string {
    const value = recordValues[field.key];
    if (field.multiple) return Array.isArray(value) ? value.map(String).join("\n") : "";
    if (field.type === "datetime" && typeof value === "string" && value) {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) {
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
        return local.toISOString().slice(0, 16);
      }
    }
    return value === null || value === undefined ? "" : String(value);
  }

  function parseFieldInput(field: CmsField, raw: string): unknown {
    const values = field.multiple ? raw.split("\n").map((value) => value.trim()).filter(Boolean) : [raw];
    const convert = (value: string): unknown => field.type === "integer" ? (value === "" ? null : Number(value))
      : field.type === "decimal" ? (value === "" ? null : Number(value))
        : field.type === "datetime" ? (value === "" ? "" : new Date(value).toISOString())
        : value;
    return field.multiple ? values.map(convert) : (field.type === "integer" || field.type === "decimal") && raw === "" ? null : convert(raw);
  }

  function setRelation(field: CmsField, event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    const options = relatedOptions(field);
    const selected = [...select.selectedOptions].filter((option) => option.value).map((option) => options.find((item) => item.id === option.value)).filter((item): item is RelationOption => Boolean(item));
    recordValues[field.key] = field.multiple ? selected.map((item) => item.id) : selected[0]?.id ?? "";
    relationSelections = { ...relationSelections, [field.key]: selected };
  }

  async function saveRecord(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!selectedType) return;
    busy = true; error = ""; notice = "";
    try {
      const values = Object.fromEntries(selectedType.fields.filter((field) => Object.hasOwn(recordValues, field.key)).map((field) => [field.key, recordValues[field.key]]));
      const payload = { typeKey: selectedType.key, title: recordTitle, slug: recordSlug, locale: recordLocale, status: recordStatus, excerpt: recordExcerpt, values, terms: recordTerms, ...(selectedRecord ? { head: selectedRecord.headRevision } : {}) };
      const result = selectedRecord
        ? await api<{ record: CmsRecord }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records/${encodeURIComponent(selectedRecord.id)}`, { method: "PUT", body: JSON.stringify(payload) })
        : await api<{ record: CmsRecord }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records`, { method: "POST", body: JSON.stringify(payload) });
      notice = selectedRecord ? t("cms.content.notice.recordUpdated") : t("cms.content.notice.recordCreated");
      selectedRecordId = result.record.id;
      await loadRecords();
      editRecord(result.record);
      onChanged?.();
    } catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.saveRecord"); }
    finally { busy = false; }
  }

  async function saveType(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    busy = true; error = ""; notice = "";
    try {
      const schema = fields.map((field) => ({ key: field.key, label: field.label, type: field.type, required: field.required, public: field.public, multiple: field.multiple, ...(field.type === "enum" ? { options: field.optionsText.split(",").map((value) => value.trim()).filter(Boolean) } : {}), ...(field.type === "relation" ? { targetType: field.targetType } : {}) }));
      const current = editingType ? types.find((item) => item.key === selectedTypeKey) : undefined;
      const result = current
        ? await api<{ contentType: CmsType }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/types/${encodeURIComponent(current.key)}`, { method: "PUT", body: JSON.stringify({ label: typeLabel, fields: schema, singleTemplateRef: typePublic ? singleTemplateRef || null : null, archiveTemplateRef: typePublic ? archiveTemplateRef || null : null, public: typePublic, head: current.headRevision }) })
        : await api<{ contentType: CmsType }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/types`, { method: "POST", body: JSON.stringify({ key: typeKey, label: typeLabel, fields: schema, singleTemplateRef: typePublic ? singleTemplateRef || null : null, archiveTemplateRef: typePublic ? archiveTemplateRef || null : null, public: typePublic }) });
      types = [...types.filter((item) => item.key !== result.contentType.key), result.contentType].sort((a, b) => a.label.localeCompare(b.label));
      selectedTypeKey = result.contentType.key;
      recordSearch = ""; recordsOffset = 0;
      creatingType = false; editingType = false; typeKey = ""; typeLabel = ""; fields = []; singleTemplateRef = ""; archiveTemplateRef = ""; typePublic = true;
      resetRecord(); await loadRecords();
      notice = current ? t("cms.content.notice.structureUpdated") : t("cms.content.notice.typeCreated");
      onChanged?.();
    } catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.saveType"); }
    finally { busy = false; }
  }

  function editType(type: CmsType): void {
    selectedTypeKey = type.key;
    typeKey = type.key;
    typeLabel = type.label;
    singleTemplateRef = type.singleTemplateRef ?? "";
    archiveTemplateRef = type.archiveTemplateRef ?? "";
    typePublic = type.public !== false;
    fields = type.fields.map((field) => ({ ...field, optionsText: field.options?.join(", ") ?? "", targetType: field.targetType ?? "" }));
    creatingType = true;
    editingType = true;
    error = "";
    void refreshRecords().catch(() => undefined);
  }

  async function saveQuery(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!selectedType || querySaving) return;
    querySaving = true; error = ""; notice = "";
    try {
      const existing = presets.find((item) => item.key === queryKey);
      const filter = buildQueryFilter();
      const result = await api<{ preset: QueryPreset }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/query-presets${existing ? `/${encodeURIComponent(existing.key)}` : ""}`, { method: existing ? "PUT" : "POST", body: JSON.stringify({ key: queryKey, label: queryLabel, typeKey: selectedType.key, limit: queryLimit, offset: queryOffset, orderBy: queryOrderBy, order: queryOrder, ...(filter ? { filter } : {}), ...(existing ? { head: existing.headRevision } : { expectedHead: null }) }) });
      presets = [...presets.filter((item) => item.key !== result.preset.key), result.preset];
      queryKey = ""; queryLabel = ""; queryLimit = 10; queryOffset = 0; queryFilterMode = "none"; queryFilterField = ""; queryFilterValue = ""; queryFilterTerms = []; queryRelationSearch = ""; queryRelationOptions = [];
      editingQuery = false;
      notice = t("cms.content.notice.querySaved");
      onChanged?.();
    } catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.saveQuery"); }
    finally { querySaving = false; }
  }

  function buildQueryFilter(): CmsFilter | undefined {
    if (queryFilterMode === "none") return undefined;
    if (queryFilterMode === "taxonomy") {
      if (!queryFilterTaxonomy || !queryFilterTerms.length) throw new Error(t("cms.content.error.filterTaxonomy"));
      return { taxonomyKey: queryFilterTaxonomy, termIds: [...queryFilterTerms], operator: queryFilterTaxonomyOperator };
    }
    if (!queryField) throw new Error(t("cms.content.error.filterField"));
    if (queryFilterOperator === "exists") return { field: queryFilterField, op: "exists" };
    if (queryField.type === "relation") {
      if (queryFilterOperator !== "eq" || !queryFilterValue || !queryRelationOptions.some((record) => record.id === queryFilterValue)) throw new Error(t("cms.content.error.filterRelation"));
      return { field: queryFilterField, op: "eq", value: queryFilterValue };
    }
    const parse = (raw: string): unknown => queryField.type === "integer" || queryField.type === "decimal"
      ? Number(raw)
      : queryField.type === "boolean" ? raw === "true" : raw;
    if (queryFilterOperator === "in") {
      const values = queryFilterValue.split("\n").map((value) => value.trim()).filter(Boolean).map(parse);
      if (!values.length) throw new Error(t("cms.content.error.filterValues"));
      return { field: queryFilterField, op: "in", value: values };
    }
    if (queryFilterValue === "") throw new Error(t("cms.content.error.filterValue"));
    const value = parse(queryFilterValue);
    if ((queryField.type === "integer" && !Number.isSafeInteger(value)) || (queryField.type === "decimal" && (typeof value !== "number" || !Number.isFinite(value)))) {
      throw new Error(t("cms.content.error.filterNumber"));
    }
    return { field: queryFilterField, op: queryFilterOperator as Extract<CmsFilter, { field: string }>["op"], value };
  }

  async function searchQueryRelations(): Promise<void> {
    if (!queryField || queryField.type !== "relation" || !queryField.targetType) return;
    queryRelationLoading = true;
    error = "";
    try {
      const params = new URLSearchParams({ type: queryField.targetType, status: "published", limit: "100", offset: "0" });
      if (queryRelationSearch.trim()) params.set("q", queryRelationSearch.trim());
      const result = await api<{ items: CmsRecord[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records?${params}`);
      const merged = new Map(queryRelationOptions.map((item) => [item.id, item]));
      for (const record of result.items) merged.set(record.id, { id: record.id, title: record.title, slug: record.slug, locale: record.locale, status: record.status });
      queryRelationOptions = [...merged.values()];
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t("cms.content.error.searchRelated");
    } finally { queryRelationLoading = false; }
  }

  async function loadQueryRelation(id: string, typeKey: string): Promise<void> {
    const result = await api<{ record: CmsRecord }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/records/${encodeURIComponent(id)}`);
    if (result.record.typeKey !== typeKey || result.record.status !== "published") throw new Error(t("cms.content.error.savedRelationUnavailable"));
    queryRelationOptions = [{ id, title: result.record.title, slug: result.record.slug, locale: result.record.locale, status: result.record.status }, ...queryRelationOptions.filter((item) => item.id !== id)];
  }

  function resolveQueryFieldPath(typeKey: string, fieldPath: string): CmsField | undefined {
    const segments = fieldPath.split(".");
    let type = types.find((item) => item.key === typeKey);
    let field: CmsField | undefined;
    for (const [index, segment] of segments.entries()) {
      field = type?.fields.find((item) => item.key === segment && item.public);
      if (!field) return undefined;
      if (index < segments.length - 1) {
        if (field.type !== "relation" || !field.targetType) return undefined;
        type = types.find((item) => item.key === field?.targetType);
      }
    }
    return field;
  }

  function previewValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(previewValue).filter(Boolean).join(", ");
    if (typeof value === "object") {
      const item = value as { title?: unknown; alt?: unknown; slug?: unknown };
      return String(item.title ?? item.alt ?? item.slug ?? "…");
    }
    return String(value);
  }

  function previewFields(item: CmsQueryPreviewItem): string {
    const fields = item.fields && typeof item.fields === "object" && !Array.isArray(item.fields) ? item.fields : {};
    return Object.entries(fields).map(([key, value]) => `${key}: ${previewValue(value)}`).join(" · ");
  }

  async function previewQuery(preset: QueryPreset): Promise<void> {
    busy = true; error = "";
    try {
      const result = await api<{ items: CmsQueryPreviewItem[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/query-presets/${encodeURIComponent(preset.key)}/preview`, { method: "POST", body: JSON.stringify({}) });
      previewItems = result.items; notice = tp("cms.content.count.previewResults", result.items.length);
    } catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.previewQuery"); }
    finally { busy = false; }
  }

  async function editQuery(preset: QueryPreset): Promise<void> {
    const filter = preset.filter;
    if (filter && ("and" in filter || "or" in filter)) {
      error = t("cms.content.error.advancedFilter");
      return;
    }
    selectedTypeKey = preset.typeKey;
    recordsOffset = 0;
    editingQuery = true;
    queryKey = preset.key; queryLabel = preset.label; queryLimit = preset.limit; queryOffset = preset.offset ?? 0; queryOrder = preset.order;
    queryOrderBy = preset.orderBy;
    queryFilterMode = "none"; queryFilterField = ""; queryFilterValue = ""; queryFilterTerms = [];
    if (filter && "taxonomyKey" in filter) {
      queryFilterMode = "taxonomy"; queryFilterTaxonomy = filter.taxonomyKey; queryFilterTerms = [...filter.termIds]; queryFilterTaxonomyOperator = filter.operator;
    } else if (filter && "field" in filter) {
      queryFilterMode = "field"; queryFilterField = filter.field; queryFilterOperator = filter.op; queryRelationOptions = []; queryRelationSearch = "";
      queryFilterValue = Array.isArray(filter.value) ? filter.value.map(String).join("\n") : String(filter.value ?? "");
      const relationField = resolveQueryFieldPath(preset.typeKey, filter.field);
      if (relationField && filter.op === "eq" && typeof filter.value === "string") {
        try { await loadQueryRelation(filter.value, relationField.targetType ?? ""); }
        catch (cause) { error = cause instanceof Error ? cause.message : t("cms.content.error.queryRelationMissing"); }
      }
    }
    previewItems = []; notice = t("cms.content.notice.editingQuery", { key: preset.key });
    void refreshRecords().catch(() => undefined);
  }

  function keyFromLabel(label: string): string {
    return label.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^A-Za-z0-9_]+/gu, "_").replace(/^\d+/u, "").replace(/^_+|_+$/gu, "").toLowerCase().slice(0, 63);
  }

  function addField(): void {
    const next = fields.length + 1;
    fields = [...fields, { key: t("cms.content.field.newKey", { n: next }), label: t("cms.content.field.newLabel", { n: next }), type: "text", required: false, public: true, multiple: false, optionsText: "", targetType: types[0]?.key ?? "" }];
  }
</script>

<section class="content-manager" aria-labelledby="cms-content-title">
  <div class="content-heading">
    <div><div class="content-eyebrow">{t("cms.content.eyebrow")}</div><h2 id="cms-content-title">{t("cms.content.title")}</h2><p>{t("cms.content.subtitle")}</p></div>
    <button class="button primary" type="button" onclick={() => { creatingType = !creatingType; editingType = false; typeKey = ""; typeLabel = ""; fields = []; singleTemplateRef = ""; archiveTemplateRef = ""; typePublic = true; error = ""; }}>{t("cms.content.newType")}</button>
  </div>

  {#if error}<div class="content-alert error" role="alert">{error}</div>{/if}
  {#if notice}<div class="content-alert success" role="status">{notice}</div>{/if}

  {#if creatingType}
    <form class="content-card" onsubmit={saveType}>
      <div class="content-card-head"><div><h3>{editingType ? t("cms.content.type.editTitle") : t("cms.content.type.newTitle")}</h3><p>{t("cms.content.type.hint")}</p></div><button class="button text small" type="button" onclick={() => { creatingType = false; editingType = false; fields = []; }}>{t("cms.content.close")}</button></div>
      <div class="content-form-grid">
        <label>{t("cms.content.label")}<input bind:value={typeLabel} oninput={() => { typeKey = keyFromLabel(typeLabel); }} maxlength="120" required placeholder={t("cms.content.type.labelPlaceholder")} /></label>
        <label>{t("cms.content.key")}<input bind:value={typeKey} pattern={typeKeyPattern} required placeholder={t("cms.content.type.keyPlaceholder")} readonly={editingType} /><small>{t("cms.content.type.keyHint")}</small></label>
        <label class="check"><input type="checkbox" bind:checked={typePublic} /> {t("cms.content.type.public")}<small>{typePublic ? t("cms.content.type.publicHint") : t("cms.content.type.privateHint")}</small></label>
        {#if typePublic}
        <label>{t("cms.content.type.singleTemplate")}<select bind:value={singleTemplateRef}><option value="">{t("cms.content.type.singleTemplateDefault")}</option>{#each templates as template (template.ref)}<option value={template.ref}>{template.title} · {template.ref}</option>{/each}</select><small>{t("cms.content.type.singleTemplateHint")}</small></label>
        <label>{t("cms.content.type.archiveTemplate")}<select bind:value={archiveTemplateRef}><option value="">{t("cms.content.type.archiveTemplateDefault")}</option>{#each templates as template (template.ref)}<option value={template.ref}>{template.title} · {template.ref}</option>{/each}</select><small>{t("cms.content.type.archiveTemplateHint")}</small></label>
        {/if}
      </div>
      <div class="field-builder-title"><h4>{t("cms.content.fields.title")}</h4><button class="button outline small" type="button" onclick={addField}>{t("cms.content.fields.add")}</button></div>
      {#if fields.length === 0}<p class="content-empty-inline">{t("cms.content.fields.empty")}</p>{/if}
      {#each fields as field, index (index)}
        <div class="field-builder-row">
          <label>{t("cms.content.field.label")}<input bind:value={field.label} maxlength="120" required oninput={() => { field.key = keyFromLabel(field.label); }} /></label>
          <label>{t("cms.content.field.key")}<input bind:value={field.key} pattern={fieldKeyPattern} required /></label>
          <label>{t("cms.content.field.type")}<select bind:value={field.type}><option value="text">{t("cms.content.fieldType.text")}</option><option value="rich-text">{t("cms.content.fieldType.rich-text")}</option><option value="integer">{t("cms.content.fieldType.integer")}</option><option value="decimal">{t("cms.content.fieldType.decimal")}</option><option value="boolean">{t("cms.content.fieldType.boolean")}</option><option value="date">{t("cms.content.fieldType.date")}</option><option value="datetime">{t("cms.content.fieldType.datetime")}</option><option value="enum">{t("cms.content.fieldType.enum")}</option><option value="url">{t("cms.content.fieldType.url")}</option><option value="asset">{t("cms.content.fieldType.asset")}</option><option value="relation">{t("cms.content.fieldType.relation")}</option></select></label>
          <div class="field-flags"><label><input type="checkbox" bind:checked={field.required} /> {t("cms.content.field.required")}</label><label><input type="checkbox" bind:checked={field.public} /> {t("cms.content.field.public")}</label><label><input type="checkbox" bind:checked={field.multiple} disabled={field.type === "boolean"} /> {t("cms.content.field.multiple")}</label><button class="button text small" type="button" onclick={() => fields = fields.filter((_, itemIndex) => itemIndex !== index)} aria-label={t("cms.content.field.removeLabel", { label: field.label })}>{t("cms.content.field.remove")}</button></div>
          {#if field.type === "enum"}<label class="field-wide">{t("cms.content.field.options")}<input bind:value={field.optionsText} placeholder={t("cms.content.field.optionsPlaceholder")} required /></label>{/if}
          {#if field.type === "relation"}<label class="field-wide">{t("cms.content.field.target")}<select bind:value={field.targetType} required><option value="">{t("cms.content.field.targetPlaceholder")}</option>{#each types as type (type.id)}<option value={type.key}>{type.label}</option>{/each}</select></label>{/if}
        </div>
      {/each}
      <div class="content-actions"><button class="button primary" type="submit" disabled={busy || !fields.length}>{editingType ? t("cms.content.type.saveStructure") : t("cms.content.type.create")}</button></div>
    </form>
  {/if}

  <div class="content-layout">
    <aside class="content-card type-list" aria-label={t("cms.content.types.aria")}>
      <div class="content-card-head"><div><h3>{t("cms.content.types.title")}</h3><p>{tp("cms.content.count.defined", types.length)}</p></div></div>
      {#if types.length}
        {#each types as type (type.id)}
          <button class="type-row" class:active={selectedTypeKey === type.key} type="button" onclick={() => chooseType(type.key)}><span><strong>{type.label}</strong><small>{type.key} · {tp("cms.content.count.fields", type.fields.length)}</small></span><span aria-hidden="true">›</span></button>
        {/each}
      {:else}<p class="content-empty-inline">{t("cms.content.types.empty")}</p>{/if}
    </aside>

    <div class="content-workspace">
      {#if selectedType}
        <section class="content-card records-panel">
          <div class="content-card-head"><div><h3>{selectedType.label}</h3><p>{t("cms.content.records.hint")}</p></div><div class="content-actions-inline"><button class="button outline small" type="button" onclick={() => editType(selectedType)}>{t("cms.content.type.editFields")}</button><button class="button outline small" type="button" onclick={resetRecord}>{t("cms.content.records.new")}</button></div></div>
          <div class="record-columns">
            <div class="record-list" aria-label={t("cms.content.records.aria")}>
              <form class="record-search" onsubmit={(event) => { event.preventDefault(); searchRecordList(); }}>
                <label for="cms-record-search">{t("cms.content.searchLabel")}</label>
                <div><input id="cms-record-search" type="search" maxlength="120" bind:value={recordSearch} placeholder={t("cms.content.searchPlaceholder")} /><button class="button outline small" type="submit" disabled={recordsLoading}>{t("cms.content.search")}</button></div>
              </form>
              {#if records.length}
                {#each records as record (record.id)}
                  <div class="record-row-shell">{#if selecting}<label class="record-trash-check"><input type="checkbox" checked={selectedForTrash.includes(record.id)} aria-label={trashSelectionLabel?.(record.title) ?? record.title} onchange={(event) => onTrashSelectionChange?.(record.id, (event.currentTarget as HTMLInputElement).checked)} /></label>{/if}<button class="record-row" class:active={selectedRecordId === record.id} type="button" onclick={() => editRecord(record)}><span class="record-status" class:published={record.status === "published"} class:archived={record.status === "archived"}></span><span><strong>{record.title}</strong><small>/{selectedType.key}/{record.slug}/ · {statusLabel(record.status)}</small></span></button></div>
                {/each}
              {:else if recordsLoading}<p class="content-empty-inline" role="status">{t("cms.content.loadingRecords")}</p>
              {:else if recordSearch.trim()}<p class="content-empty-inline">{t("cms.content.records.noMatch")}</p>
              {:else}<p class="content-empty-inline">{t("cms.content.records.empty")}</p>{/if}
              <nav class="record-pagination" aria-label={t("cms.content.pagination.aria")}>
                <span aria-live="polite">{recordsTotal ? t("cms.content.pagination.range", { from: recordsOffset + 1, to: Math.min(recordsOffset + recordPageSize, recordsTotal), total: recordsTotal }) : tp("count.records", 0)}</span>
                <div><button class="button outline small" type="button" disabled={recordsOffset === 0 || recordsLoading} onclick={() => void refreshRecords(recordsOffset - recordPageSize)}>{t("cms.content.pagination.previous")}</button><button class="button outline small" type="button" disabled={recordsOffset + recordPageSize >= recordsTotal || recordsLoading} onclick={() => void refreshRecords(recordsOffset + recordPageSize)}>{t("cms.content.pagination.next")}</button></div>
              </nav>
            </div>
            <form class="record-editor" onsubmit={saveRecord}>
              <div class="record-editor-title"><strong>{selectedRecord ? t("cms.content.record.editTitle") : t("cms.content.record.newTitle")}</strong>{#if selectedRecord}<small>{t("cms.content.record.revision", { revision: selectedRecord.headRevision.slice(0, 8) })}</small>{/if}</div>
              <div class="content-form-grid">
                <label>{t("cms.content.record.title")}<input bind:value={recordTitle} maxlength="240" required /></label>
                <label>{t("cms.content.record.slug")}<input bind:value={recordSlug} maxlength="120" placeholder={t("cms.content.record.slugPlaceholder")} /></label>
                <label>{t("cms.content.record.locale")}<input bind:value={recordLocale} maxlength="35" required placeholder="it-IT" /><small>{t("cms.content.record.localeHint")}</small></label>
                <label>{t("cms.content.record.status")}<select bind:value={recordStatus}><option value="draft">{statusLabel("draft")}</option><option value="published">{statusLabel("published")}</option><option value="archived">{statusLabel("archived")}</option></select></label>
                <label class="field-wide">{t("cms.content.record.excerpt")}<textarea bind:value={recordExcerpt} maxlength="20000" rows="2"></textarea></label>
                {#each selectedType.fields as field (field.key)}
                  {#if field.type === "relation"}
                    <div class="field-wide record-field relation-field">
                      <span>{field.label}{field.required ? t("cms.content.field.requiredSuffix") : ""}{field.public ? t("cms.content.field.publicSuffix") : t("cms.content.field.privateSuffix")}</span>
                      <div class="relation-search"><label for={`relation-search-${field.key}`}>{t("cms.content.searchLabel")}<input id={`relation-search-${field.key}`} type="search" maxlength="120" value={relationSearch[field.key] ?? ""} oninput={(event) => relationSearch = { ...relationSearch, [field.key]: (event.currentTarget as HTMLInputElement).value }} placeholder={t("cms.content.searchPlaceholder")} /></label><button class="button outline small" type="button" disabled={relationSearchLoading[field.key]} onclick={() => void searchRelatedRecords(field)}>{relationSearchLoading[field.key] ? t("cms.content.relation.searching") : t("cms.content.relation.search")}</button></div>
                      <select multiple={field.multiple} size={field.multiple ? 5 : undefined} aria-label={t("cms.content.relation.aria", { label: field.label })} onchange={(event) => setRelation(field, event)}><option value="">{t("cms.content.relation.placeholder")}</option>{#each relatedOptions(field) as option (option.id)}<option value={option.id} selected={Array.isArray(recordValues[field.key]) ? (recordValues[field.key] as unknown[]).some((item) => (typeof item === "string" ? item : (item as { id?: string }).id) === option.id) : recordValues[field.key] === option.id || (recordValues[field.key] as { id?: string } | null)?.id === option.id}>{option.title} · {recordPublicPath(option, field.targetType ?? "")}{option.status ? ` · ${statusLabel(option.status)}` : ""}</option>{/each}</select>
                      {#if relationSearchTotals[field.key] !== undefined}<small>{tp("cms.content.count.searchMatches", relationSearchTotals[field.key] ?? 0)}</small>{/if}
                    </div>
                  {:else}
                  <label class="field-wide record-field"><span>{field.label}{field.required ? t("cms.content.field.requiredSuffix") : ""}{field.public ? t("cms.content.field.publicSuffix") : t("cms.content.field.privateSuffix")}</span>
                    {#if field.type === "boolean"}
                      <span class="boolean-control"><input type="checkbox" checked={recordValues[field.key] === true} onchange={(event) => recordValues[field.key] = (event.currentTarget as HTMLInputElement).checked} /> {t("cms.content.yes")}</span>
                    {:else if field.type === "enum"}
                      {#if field.multiple}<select multiple size="3" onchange={(event) => recordValues[field.key] = [...(event.currentTarget as HTMLSelectElement).selectedOptions].map((option) => option.value)}>{#each field.options ?? [] as option}<option value={option} selected={Array.isArray(recordValues[field.key]) && (recordValues[field.key] as unknown[]).includes(option)}>{option}</option>{/each}</select>
                      {:else}<select value={String(recordValues[field.key] ?? "")} onchange={(event) => recordValues[field.key] = (event.currentTarget as HTMLSelectElement).value}><option value="">{t("cms.content.enum.placeholder")}</option>{#each field.options ?? [] as option}<option value={option}>{option}</option>{/each}</select>{/if}
                    {:else if field.type === "asset"}
                      <select multiple={field.multiple} size={field.multiple ? 3 : undefined} onchange={(event) => setRelation(field, event)}><option value="">{t("cms.content.asset.placeholder")}</option>{#each assets as asset (asset.id)}<option value={asset.id} selected={Array.isArray(recordValues[field.key]) ? (recordValues[field.key] as unknown[]).includes(asset.id) : recordValues[field.key] === asset.id}>{asset.filename}</option>{/each}</select>
                    {:else if field.type === "rich-text"}
                      <textarea rows="5" value={fieldInputValue(field)} oninput={(event) => recordValues[field.key] = parseFieldInput(field, (event.currentTarget as HTMLTextAreaElement).value)}></textarea>
                    {:else}
                      <input type={field.type === "integer" || field.type === "decimal" ? "number" : field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : field.type === "url" ? "url" : "text"} step={field.type === "decimal" ? "any" : undefined} value={fieldInputValue(field)} oninput={(event) => recordValues[field.key] = parseFieldInput(field, (event.currentTarget as HTMLInputElement).value)} />
                    {/if}
                    {#if field.multiple && !["enum", "relation", "asset", "boolean"].includes(field.type)}<small>{t("cms.content.field.multipleHint")}</small>{/if}
                  </label>
                  {/if}
                {/each}
                {#each recordTaxonomies as taxonomy (taxonomy.id)}
                  <label class="field-wide record-field"><span>{taxonomy.label}</span>
                    <select multiple size="3" onchange={(event) => setRecordTerms(taxonomy.key, event)}>
                      {#each taxonomyTerms[taxonomy.key] ?? [] as term (term.id)}<option value={term.alias} selected={(recordTerms[taxonomy.key] ?? []).includes(term.alias)}>{term.label}</option>{/each}
                    </select>
                    {#if !(taxonomyTerms[taxonomy.key] ?? []).length}<small>{t("cms.content.terms.emptyHint")}</small>{/if}
                  </label>
                {/each}
              </div>
              {#if selectedRecord && recordStatus !== "archived"}<button class="button text small" type="button" onclick={() => recordStatus = "archived"}>{t("cms.content.record.archive")}</button>{/if}
              <div class="content-actions"><button class="button primary" type="submit" disabled={busy || !recordTitle.trim()}>{busy ? t("cms.content.saving") : t("cms.content.record.save")}</button></div>
            </form>
          </div>
        </section>
      {:else}
        <section class="content-card content-empty"><h3>{t("cms.content.types.noneTitle")}</h3><p>{t("cms.content.types.noneHint")}</p></section>
      {/if}

      {#if selectedType}
        <section class="content-card taxonomy-panel">
          <div class="content-card-head"><div><h3>{t("cms.content.taxonomies.title")}</h3><p>{t("cms.content.taxonomies.hint")}</p></div><button class="button outline small" type="button" onclick={() => { creatingTaxonomy = !creatingTaxonomy; taxonomyTypes = selectedType ? [selectedType.key] : []; }}>{t("cms.content.taxonomies.new")}</button></div>
          {#if creatingTaxonomy}
            <form class="taxonomy-create" onsubmit={saveTaxonomy}>
              <div class="content-form-grid">
                <label>{t("cms.content.label")}<input bind:value={taxonomyLabel} maxlength="120" required placeholder={t("cms.content.taxonomy.labelPlaceholder")} oninput={() => { taxonomyKey = keyFromLabel(taxonomyLabel); }} /></label>
                <label>{t("cms.content.key")}<input bind:value={taxonomyKey} pattern={typeKeyPattern} required placeholder={t("cms.content.taxonomy.keyPlaceholder")} /></label>
              </div>
              <fieldset><legend>{t("cms.content.taxonomy.types")}</legend><div class="field-flags">{#each types as type (type.id)}<label><input type="checkbox" checked={taxonomyTypes.includes(type.key)} onchange={() => taxonomyTypes = taxonomyTypes.includes(type.key) ? taxonomyTypes.filter((key) => key !== type.key) : [...taxonomyTypes, type.key]} /> {type.label}</label>{/each}</div></fieldset>
              <div class="content-actions"><button class="button primary" type="submit" disabled={busy || !taxonomyTypes.length}>{t("cms.content.taxonomy.create")}</button></div>
            </form>
          {/if}
          {#if taxonomies.length}
            <div class="taxonomy-manager">
              <label>{t("cms.content.taxonomy.label")}<select bind:value={selectedTaxonomyKey}><option value="">{t("cms.content.taxonomy.choose")}</option>{#each taxonomies as taxonomy (taxonomy.id)}<option value={taxonomy.key}>{taxonomy.label} · {taxonomy.key}</option>{/each}</select></label>
              {#if selectedTaxonomyKey}
                <form class="taxonomy-create" onsubmit={saveTerm}>
                  <div class="content-form-grid"><label>{t("cms.content.term.label")}<input bind:value={termLabel} maxlength="120" required placeholder={t("cms.content.term.labelPlaceholder")} oninput={() => { if (!termSlug) termSlug = keyFromLabel(termLabel); }} /></label><label>{t("cms.content.record.slug")}<input bind:value={termSlug} maxlength="120" required /></label></div>
                  <div class="content-actions"><button class="button outline small" type="submit" disabled={busy}>{t("cms.content.term.add")}</button></div>
                </form>
                <ul class="taxonomy-terms">{#each taxonomyTerms[selectedTaxonomyKey] ?? [] as term (term.id)}<li><span>{term.label}<small>/{term.slug}/</small></span><span>{tp("count.records", term.count)}</span></li>{/each}</ul>
              {/if}
            </div>
          {:else}<p class="content-empty-inline">{t("cms.content.taxonomies.empty")}</p>{/if}
        </section>
      {/if}

      {#if selectedType}
        <section class="content-card queries-panel">
          <div class="content-card-head"><div><h3>{t("cms.content.queries.title")}</h3><p>{t("cms.content.queries.hint")}</p></div></div>
          <form class="query-form" onsubmit={saveQuery}>
            <label>{t("cms.content.key")}<input bind:value={queryKey} pattern={queryKeyPattern} required placeholder={t("cms.content.query.keyPlaceholder")} /></label>
            <label>{t("cms.content.label")}<input bind:value={queryLabel} required placeholder={t("cms.content.query.labelPlaceholder")} /></label>
            <label>{t("cms.content.query.limit")}<input type="number" bind:value={queryLimit} min="1" max="100" required /></label>
            <label>{t("cms.content.query.offset")}<input type="number" bind:value={queryOffset} min="0" max="1000000" required /></label>
            <label>{t("cms.content.query.orderBy")}<select bind:value={queryOrderBy}><option value="publishedAt">{t("cms.content.query.orderBy.publishedAt")}</option><option value="updatedAt">{t("cms.content.query.orderBy.updatedAt")}</option><option value="createdAt">{t("cms.content.query.orderBy.createdAt")}</option><option value="title">{t("cms.content.query.orderBy.title")}</option><option value="order">{t("cms.content.query.orderBy.order")}</option></select></label>
            <label>{t("cms.content.query.direction")}<select bind:value={queryOrder}><option value="desc">{t("cms.content.query.direction.desc")}</option><option value="asc">{t("cms.content.query.direction.asc")}</option></select></label>
            <label>{t("cms.content.query.filter")}<select bind:value={queryFilterMode}><option value="none">{t("cms.content.query.filter.none")}</option><option value="field">{t("cms.content.query.filter.field")}</option><option value="taxonomy" disabled={!recordTaxonomies.length}>{t("cms.content.query.filter.taxonomy")}</option></select></label>
            {#if queryFilterMode === "field"}
              <label>{t("cms.content.query.field")}<select bind:value={queryFilterField} onchange={() => { queryFilterValue = ""; queryRelationSearch = ""; queryRelationOptions = []; queryFilterOperator = queryFilterPaths.find((item) => item.path === queryFilterField)?.field.multiple ? "exists" : "eq"; }} required><option value="">{t("cms.content.query.fieldPlaceholder")}</option>{#each queryFilterPaths as item (item.path)}<option value={item.path}>{item.label}</option>{/each}</select></label>
              <label>{t("cms.content.query.condition")}<select bind:value={queryFilterOperator}>{#if queryField?.type === "relation"}<option value="eq" disabled={queryField.multiple}>{t("cms.content.query.op.relationEq")}</option><option value="exists">{t("cms.content.query.op.relationExists")}</option>{:else}<option value="eq">{t("cms.content.query.op.eq")}</option><option value="ne">{t("cms.content.query.op.ne")}</option><option value="in">{t("cms.content.query.op.in")}</option><option value="contains" disabled={queryField?.type === "integer" || queryField?.type === "decimal" || queryField?.type === "boolean"}>{t("cms.content.query.op.contains")}</option><option value="lt" disabled={queryField?.type === "boolean" || queryField?.type === "enum"}>{t("cms.content.query.op.lt")}</option><option value="lte" disabled={queryField?.type === "boolean" || queryField?.type === "enum"}>{t("cms.content.query.op.lte")}</option><option value="gt" disabled={queryField?.type === "boolean" || queryField?.type === "enum"}>{t("cms.content.query.op.gt")}</option><option value="gte" disabled={queryField?.type === "boolean" || queryField?.type === "enum"}>{t("cms.content.query.op.gte")}</option><option value="exists">{t("cms.content.query.op.exists")}</option>{/if}</select></label>
              {#if queryFilterOperator !== "exists"}
                {#if queryField?.type === "relation"}
                  <div class="query-relation-picker">
                    <label>{t("cms.content.query.relationSearch")}<input bind:value={queryRelationSearch} maxlength="120" placeholder={t("cms.content.searchPlaceholder")} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchQueryRelations(); } }} /></label>
                    <button class="button outline small" type="button" disabled={queryRelationLoading || !queryField.targetType} onclick={() => void searchQueryRelations()}>{queryRelationLoading ? t("cms.content.query.searching") : t("cms.content.search")}</button>
                    <label class="query-relation-select">{t("cms.content.query.relationRecord")}<select bind:value={queryFilterValue} required><option value="">{t("cms.content.query.relationPlaceholder")}</option>{#each queryRelationOptions as record (record.id)}<option value={record.id}>{record.title} · {recordPublicPath(record, queryField.targetType ?? "")}</option>{/each}</select></label>
                    <small>{t("cms.content.query.relationHint")}</small>
                  </div>
                {:else if queryField?.type === "boolean" && queryFilterOperator !== "in"}
                  <label>{t("cms.content.query.value")}<select bind:value={queryFilterValue}><option value="true">{t("cms.content.yes")}</option><option value="false">{t("cms.content.no")}</option></select></label>
                {:else}
                  <label class="query-filter-value">{queryFilterOperator === "in" ? t("cms.content.query.values") : t("cms.content.query.value")}{#if queryFilterOperator === "in"}<textarea bind:value={queryFilterValue} rows="2" required placeholder={t("cms.content.query.valuesPlaceholder")}></textarea>{:else}<input bind:value={queryFilterValue} type={queryField?.type === "integer" || queryField?.type === "decimal" ? "number" : queryField?.type === "date" ? "date" : "text"} step={queryField?.type === "decimal" ? "any" : undefined} required />{/if}</label>
                {/if}
              {/if}
            {:else if queryFilterMode === "taxonomy"}
              <label>{t("cms.content.taxonomy.label")}<select bind:value={queryFilterTaxonomy} onchange={() => queryFilterTerms = []} required><option value="">{t("cms.content.taxonomy.choose")}</option>{#each recordTaxonomies as taxonomy (taxonomy.id)}<option value={taxonomy.key}>{taxonomy.label}</option>{/each}</select></label>
              <label>{t("cms.content.query.condition")}<select bind:value={queryFilterTaxonomyOperator}><option value="IN">{t("cms.content.query.taxonomyOp.IN")}</option><option value="AND">{t("cms.content.query.taxonomyOp.AND")}</option><option value="NOT IN">{t("cms.content.query.taxonomyOp.NOT IN")}</option></select></label>
              <label class="query-filter-value">{t("cms.content.query.terms")}<select multiple size="3" bind:value={queryFilterTerms}>{#each taxonomyTerms[queryFilterTaxonomy] ?? [] as term (term.id)}<option value={term.id}>{term.label}</option>{/each}</select></label>
            {/if}
            <button class="button primary" type="submit" disabled={busy || querySaving || !queryKey.trim() || !queryLabel.trim()}>{querySaving ? t("cms.content.saving") : editingQuery ? t("cms.content.query.update") : t("cms.content.query.save")}</button>
          </form>
          {#if presets.length}
            <div class="query-list">{#each presets as preset (preset.key)}<div class="query-row"><span><strong>{preset.label}</strong><small><code>{preset.key}</code> · {preset.typeKey} · max {preset.limit} · offset {preset.offset ?? 0} · {preset.orderBy} {preset.order}</small></span><div class="content-actions-inline"><button class="button outline small" type="button" disabled={busy || querySaving} onclick={() => void editQuery(preset)}>{t("cms.content.query.edit")}</button><button class="button outline small" type="button" disabled={busy || querySaving} onclick={() => void previewQuery(preset)}>{t("cms.content.query.preview")}</button></div></div>{/each}</div>
          {/if}
          {#if previewItems.length}<ul class="query-preview">{#each previewItems as item (`${item.url}:${item.title}`)}<li><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a><small>{previewFields(item)}</small></li>{/each}</ul>{/if}
        </section>
      {/if}
    </div>
  </div>
</section>

<style>
  .record-row-shell{display:flex;align-items:stretch;border-top:1px solid var(--line)}.record-trash-check{display:flex;flex:0 0 38px;align-items:center;justify-content:center;margin:0}.record-trash-check input{width:16px;height:16px;margin:0;accent-color:var(--coral)}.record-row-shell .record-row{min-width:0;flex:1;border-top:0}
  .content-manager{display:grid;gap:16px;margin:18px 0 30px}.content-heading,.content-card-head,.field-builder-title,.record-editor-title,.query-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.content-heading h2{margin:2px 0 4px;font-size:1.5rem}.content-heading p,.content-card-head p{margin:0;color:var(--muted);font-size:.9rem}.content-eyebrow{color:var(--muted);font-size:.7rem;font-weight:800;letter-spacing:.12em}.content-card{min-width:0;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 16px #28223d08}.content-card-head{margin-bottom:14px}.content-card-head h3{margin:0 0 4px;font-size:1.05rem}.content-alert{padding:11px 14px;border-radius:9px;font-size:.9rem}.content-alert.error{color:var(--danger);background:var(--danger-soft);border:1px solid var(--danger-line)}.content-alert.success{color:var(--mint-ink);background:var(--mint);border:1px solid var(--mint-line)}.content-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.content-form-grid label,.field-builder-row>label,.query-form label{display:grid;gap:6px;color:var(--label);font-size:.82rem;font-weight:700}.content-form-grid input,.content-form-grid select,.content-form-grid textarea,.field-builder-row input,.field-builder-row select,.query-form input,.query-form select,.record-editor input,.record-editor select,.record-editor textarea{width:100%;min-width:0;box-sizing:border-box;padding:10px 11px;border:1px solid var(--input-border);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-weight:400}.content-form-grid small,.field-builder-row :global(small),.record-field small,.query-row small{color:var(--muted);font-size:.74rem;font-weight:400}.field-builder-title{margin:16px 0 9px}.field-builder-title h4{margin:0}.field-builder-row{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:10px;padding:12px 0;border-top:1px solid var(--line)}.field-flags{display:flex;grid-column:1/-1;align-items:center;gap:16px;flex-wrap:wrap}.field-flags label,.boolean-control{display:flex;align-items:center;gap:6px;font-size:.78rem}.field-flags input,.boolean-control input{width:auto}.field-wide{grid-column:1/-1}.content-actions{display:flex;justify-content:flex-end;margin-top:12px}.content-empty-inline{margin:8px 0;color:var(--muted);font-size:.88rem}.content-layout{display:grid;grid-template-columns:minmax(190px,.28fr) minmax(0,1fr);align-items:start;gap:14px}.type-row,.record-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border:0;border-top:1px solid var(--line);background:var(--panel);color:var(--ink);text-align:left;cursor:pointer}.type-row.active,.record-row.active{background:var(--panel-soft);color:var(--ink)}.type-row span:first-child,.record-row span:last-child,.query-row span{display:grid;gap:4px}.type-row small,.record-row small{color:var(--muted);font-size:.74rem}.record-columns{display:grid;grid-template-columns:minmax(155px,.34fr) minmax(0,1fr);gap:14px}.record-list{border:1px solid var(--line);border-radius:9px;overflow:auto;max-height:560px}.record-row{justify-content:flex-start}.record-status{width:9px;height:9px;flex:none;border-radius:50%;background:#dcaa63}.record-status.published{background:#56a87d}.record-status.archived{background:#8990a0}.record-editor{padding:14px;border:1px solid var(--line);border-radius:9px}.record-editor-title{margin-bottom:12px}.record-editor-title small{color:var(--muted)}.record-field{margin-top:2px}.record-field>span:first-child{font-size:.8rem;color:var(--label)}.query-form{display:grid;grid-template-columns:1fr 1.3fr .7fr 1fr auto;align-items:end;gap:10px}.query-list{margin-top:12px;border-top:1px solid var(--line)}.query-row{padding:10px 2px;border-bottom:1px solid var(--line)}.query-preview{margin:10px 0 0;padding-left:20px}.query-preview li{margin:8px 0}.query-preview small{display:block;color:var(--muted)}.content-empty{min-height:140px}@media(max-width:900px){.content-layout,.record-columns{grid-template-columns:1fr}.type-list{order:0}.query-form{grid-template-columns:repeat(2,minmax(0,1fr))}.query-form button{grid-column:1/-1;justify-self:end}}@media(max-width:600px){.content-heading,.content-card-head{align-items:flex-start;flex-direction:column}.content-form-grid,.field-builder-row,.query-form{grid-template-columns:1fr}.field-wide,.field-flags,.query-form button{grid-column:auto}.content-card{padding:14px}.field-flags{gap:9px}}
  .taxonomy-panel fieldset{margin:12px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px}.taxonomy-panel legend{padding:0 4px;color:var(--label);font-size:.8rem;font-weight:700}.taxonomy-create{display:grid;gap:10px;margin:10px 0;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--panel-soft)}.taxonomy-manager{display:grid;gap:12px}.taxonomy-manager>label{display:grid;gap:6px;max-width:480px;color:var(--label);font-size:.82rem;font-weight:700}.taxonomy-manager select{box-sizing:border-box;width:100%;padding:10px 11px;border:1px solid var(--input-border);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-weight:400}.taxonomy-terms{display:grid;gap:0;margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}.taxonomy-terms li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 2px;border-bottom:1px solid var(--line);color:var(--label);font-size:.82rem}.taxonomy-terms li span:first-child{display:grid;gap:3px}.taxonomy-terms small,.taxonomy-terms li span:last-child{color:var(--muted);font-size:.74rem}
  .query-form{grid-template-columns:repeat(3,minmax(0,1fr))}.query-form button{grid-column:1/-1;justify-self:end}.query-form textarea{width:100%;min-width:0;box-sizing:border-box;padding:10px 11px;border:1px solid var(--input-border);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-weight:400;resize:vertical}.query-filter-value{grid-column:span 2}.query-preview li a{overflow-wrap:anywhere}.query-preview li small{overflow-wrap:anywhere}@media(max-width:900px){.query-form{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.query-filter-value{grid-column:auto}.query-form button{grid-column:auto;justify-self:stretch}}
  .query-relation-picker{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px}.query-relation-picker label{display:grid;gap:6px;color:var(--label);font-size:.82rem;font-weight:700}.query-relation-picker input,.query-relation-picker select{box-sizing:border-box;width:100%;min-width:0;padding:10px 11px;border:1px solid var(--input-border);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-weight:400}.query-relation-picker .query-relation-select,.query-relation-picker small{grid-column:1/-1}.query-relation-picker small{color:var(--muted);font-size:.74rem;font-weight:400}@media(max-width:600px){.query-relation-picker{grid-template-columns:1fr}.query-relation-picker button,.query-relation-picker .query-relation-select,.query-relation-picker small{grid-column:auto}.query-relation-picker button{justify-self:start}}
  .record-search{display:grid;gap:6px;padding:10px;border-bottom:1px solid var(--line)}.record-search label,.relation-search label{display:grid;gap:5px;color:var(--label);font-size:.76rem;font-weight:700}.record-search>div,.relation-search{display:flex;align-items:end;gap:7px}.record-search input,.relation-search input{box-sizing:border-box;min-width:0;width:100%;padding:8px 9px;border:1px solid var(--input-border);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:.82rem;font-weight:400}.record-search button,.relation-search button{flex:none}.record-pagination{display:grid;gap:8px;padding:10px;border-top:1px solid var(--line);color:var(--muted);font-size:.76rem}.record-pagination>div{display:flex;gap:7px}.record-pagination button{flex:1}.relation-field{display:grid;gap:8px}.relation-field>span{font-size:.8rem;color:var(--label)}.relation-field select{width:100%;min-width:0;box-sizing:border-box;padding:9px;border:1px solid var(--input-border);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:.82rem}.relation-field>small{color:var(--muted);font-size:.74rem}.relation-search{align-items:end}.relation-search label{flex:1;min-width:0}
</style>
