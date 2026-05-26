<svelte:options runes={true} />
<script lang="ts">
  import { normalizeDeviceId } from "@syncpeer/core/browser";

  interface RunDiagnosticsArgs {
    expectedAdvertisedDeviceIds?: string[];
    failOnExpectedMissing?: boolean;
  }

  interface DiagnosticsCategory {
    id: string;
    name: string;
    description: string;
  }

  interface DiagnosticsTest {
    id: string;
    name: string;
    description: string;
    categoryId: string;
  }

  interface DiagnosticsCatalog {
    categories: DiagnosticsCategory[];
    tests: DiagnosticsTest[];
  }

  interface Props {
    onBack: () => void;
    onLoadCatalog: () => Promise<DiagnosticsCatalog>;
    onRunTest: (testId: string, args?: RunDiagnosticsArgs) => Promise<unknown>;
    onRunCategory: (categoryId: string, args?: RunDiagnosticsArgs) => Promise<unknown>;
  }

  let { onBack, onLoadCatalog, onRunTest, onRunCategory }: Props = $props();

  let isRunning = $state(false);
  let isCatalogLoading = $state(false);
  let catalog = $state<DiagnosticsCatalog>({ categories: [], tests: [] });
  let selectedCategoryId = $state("");
  let lastRunAt = $state("");
  let resultJson = $state("");
  let runError = $state<string | null>(null);
  let copiedNotice = $state("");
  let expectedIdsInput = $state("");

  const parseExpectedDeviceIds = (value: string): string[] => [...new Set(
    value
      .split(/[\s,;]+/g)
      .map((token) => normalizeDeviceId(token))
      .filter((token) => token.length > 0),
  )];

  let visibleTests = $derived.by(() =>
    catalog.tests.filter((item) => item.categoryId === selectedCategoryId),
  );

  const loadCatalog = async (): Promise<void> => {
    if (isCatalogLoading) return;
    isCatalogLoading = true;
    runError = null;
    try {
      const next = await onLoadCatalog();
      catalog = next;
      if (!next.categories.some((item) => item.id === selectedCategoryId)) {
        selectedCategoryId = next.categories[0]?.id ?? "";
      }
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      isCatalogLoading = false;
    }
  };

  const runSingleTest = async (testId: string): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    runError = null;
    copiedNotice = "";
    try {
      const expectedAdvertisedDeviceIds = parseExpectedDeviceIds(expectedIdsInput);
      const result = await onRunTest(testId, {
        expectedAdvertisedDeviceIds,
        failOnExpectedMissing: expectedAdvertisedDeviceIds.length > 0,
      });
      resultJson = JSON.stringify(result, null, 2);
      lastRunAt = new Date().toLocaleString();
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      isRunning = false;
    }
  };

  const runSelectedCategory = async (): Promise<void> => {
    if (isRunning || !selectedCategoryId) return;
    isRunning = true;
    runError = null;
    copiedNotice = "";
    try {
      const expectedAdvertisedDeviceIds = parseExpectedDeviceIds(expectedIdsInput);
      const result = await onRunCategory(selectedCategoryId, {
        expectedAdvertisedDeviceIds,
        failOnExpectedMissing: expectedAdvertisedDeviceIds.length > 0,
      });
      resultJson = JSON.stringify(result, null, 2);
      lastRunAt = new Date().toLocaleString();
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      isRunning = false;
    }
  };

  const copyResults = async (): Promise<void> => {
    copiedNotice = "";
    if (!resultJson.trim()) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      runError = "Clipboard API unavailable on this device";
      return;
    }
    await navigator.clipboard.writeText(resultJson);
    copiedNotice = "Copied diagnostics to clipboard.";
  };

  void loadCatalog();
</script>

<main class="diagnostics-page">
  <header class="diagnostics-header">
    <button class="ghost" onclick={onBack}>Back To Main App</button>
    <h1 class="diagnostics-title">Diagnostics</h1>
  </header>

  <section class="panel diagnostics-panel">
    <p class="hint">
      Run diagnostics by category or single test. Add expected device IDs to enforce discovery checks.
    </p>
    <label class="field-label" for="diagnostics-category">Category</label>
    <select
      id="diagnostics-category"
      bind:value={selectedCategoryId}
      disabled={isCatalogLoading || catalog.categories.length === 0}
    >
      {#each catalog.categories as category (category.id)}
        <option value={category.id}>{category.name}</option>
      {/each}
    </select>
    {#if selectedCategoryId}
      <div class="meta">
        {catalog.categories.find((item) => item.id === selectedCategoryId)?.description ?? ""}
      </div>
    {/if}
    <label class="field-label" for="expected-device-ids">Expected Advertised Device IDs (optional)</label>
    <textarea
      id="expected-device-ids"
      class="expected-box"
      value={expectedIdsInput}
      oninput={(event) => {
        expectedIdsInput = (event.currentTarget as HTMLTextAreaElement).value;
      }}
      placeholder="Paste one or more device IDs (comma/space/newline separated)."
    ></textarea>
    <div class="actions">
      <button class="primary" onclick={runSelectedCategory} disabled={isRunning || !selectedCategoryId}>
        {isRunning ? "Running..." : "Run Selected Category"}
      </button>
      <button class="ghost" onclick={loadCatalog} disabled={isCatalogLoading || isRunning}>
        {isCatalogLoading ? "Refreshing..." : "Refresh Catalog"}
      </button>
      <button class="ghost" onclick={copyResults} disabled={!resultJson}>
        Copy Results
      </button>
    </div>
    <ul class="list">
      {#if visibleTests.length === 0}
        <li class="empty">No tests in this category.</li>
      {:else}
        {#each visibleTests as test (test.id)}
          <li class="test-item">
            <div class="test-meta">
              <strong>{test.name}</strong>
              <span>{test.description}</span>
            </div>
            <button class="ghost small" onclick={() => runSingleTest(test.id)} disabled={isRunning}>
              Run Test
            </button>
          </li>
        {/each}
      {/if}
    </ul>
    {#if lastRunAt}
      <div class="meta">Last run: {lastRunAt}</div>
    {/if}
    {#if copiedNotice}
      <div class="success">{copiedNotice}</div>
    {/if}
    {#if runError}
      <div class="error">{runError}</div>
    {/if}
    <textarea
      class="result-box"
      readonly
      value={resultJson}
      placeholder="Run the test to see diagnostics output here."
    ></textarea>
  </section>
</main>

<style>
  .diagnostics-page {
    max-width: 980px;
    margin: 0 auto;
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
  }
  .diagnostics-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .diagnostics-title {
    font-size: 1.15rem;
    margin: 0;
  }
  .diagnostics-panel {
    display: grid;
    gap: 0.75rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 0.4rem;
  }
  .test-item {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.6rem;
    background: var(--bg-surface);
  }
  .test-meta {
    display: grid;
    gap: 0.15rem;
  }
  .test-meta span {
    color: var(--text-secondary);
    font-size: 0.82rem;
  }
  .small {
    min-height: 30px;
    padding: 0.15rem 0.45rem;
    font-size: 0.8rem;
  }
  .empty {
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  .hint,
  .meta {
    color: var(--text-secondary);
    margin: 0;
    font-size: 0.92rem;
  }
  .success {
    color: var(--state-success-text);
    font-size: 0.9rem;
  }
  .error {
    color: var(--state-danger-text);
    font-size: 0.9rem;
  }
  .field-label {
    color: var(--text-secondary);
    font-size: 0.86rem;
  }
  .expected-box {
    width: 100%;
    min-height: 72px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    line-height: 1.35;
    resize: vertical;
    background: var(--bg-surface-muted);
  }
  .result-box {
    width: 100%;
    min-height: 420px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    line-height: 1.35;
    resize: vertical;
    background: var(--bg-surface-muted);
  }
</style>
