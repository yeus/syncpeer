<svelte:options runes={true} />
<script lang="ts">
  import { normalizeDeviceId } from "@syncpeer/core/browser";

  interface RunDiagnosticsArgs {
    expectedAdvertisedDeviceIds?: string[];
    failOnExpectedMissing?: boolean;
  }

  interface Props {
    onBack: () => void;
    onRun: (args?: RunDiagnosticsArgs) => Promise<unknown>;
  }

  let { onBack, onRun }: Props = $props();

  let isRunning = $state(false);
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

  const runDiagnostics = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    runError = null;
    copiedNotice = "";
    try {
      const expectedAdvertisedDeviceIds = parseExpectedDeviceIds(expectedIdsInput);
      const result = await onRun({
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
</script>

<main class="diagnostics-page">
  <header class="diagnostics-header">
    <button class="ghost" onclick={onBack}>Back To Main App</button>
    <h1 class="diagnostics-title">Diagnostics</h1>
  </header>

  <section class="panel diagnostics-panel">
    <p class="hint">
      Runs folder/index diagnostics and advertised-device checks. Add specific device IDs below to assert they are advertised.
    </p>
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
      <button class="primary" onclick={runDiagnostics} disabled={isRunning}>
        {isRunning ? "Running..." : "Run Folder Diagnostics Test"}
      </button>
      <button class="ghost" onclick={copyResults} disabled={!resultJson}>
        Copy Results
      </button>
    </div>
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
