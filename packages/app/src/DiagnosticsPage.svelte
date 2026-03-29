<svelte:options runes={true} />
<script lang="ts">
  interface Props {
    onBack: () => void;
    onRun: () => Promise<unknown>;
  }

  let { onBack, onRun }: Props = $props();

  let isRunning = $state(false);
  let lastRunAt = $state("");
  let resultJson = $state("");
  let runError = $state<string | null>(null);
  let copiedNotice = $state("");

  const runDiagnostics = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    runError = null;
    copiedNotice = "";
    try {
      const result = await onRun();
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
  <header class="heading">
    <button class="ghost" onclick={onBack}>Back To Main App</button>
    <h1>Diagnostics</h1>
  </header>

  <section class="panel">
    <p class="hint">
      Runs a folder/index diagnostics test and returns a structured result object.
    </p>
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
  .heading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .heading h1 {
    font-size: 1.15rem;
    margin: 0;
  }
  .panel {
    border: 1px solid #d9dee8;
    border-radius: 12px;
    padding: 0.9rem;
    background: #fff;
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
    color: #5b6679;
    margin: 0;
    font-size: 0.92rem;
  }
  .success {
    color: #0b6b32;
    font-size: 0.9rem;
  }
  .error {
    color: #8b1e2d;
    font-size: 0.9rem;
  }
  .result-box {
    width: 100%;
    min-height: 420px;
    border: 1px solid #d9dee8;
    border-radius: 10px;
    padding: 0.7rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    line-height: 1.35;
    resize: vertical;
    background: #f8fafc;
  }
  button {
    border-radius: 8px;
    border: 1px solid #cfd6e3;
    background: #f8fafc;
    color: #111827;
    padding: 0.5rem 0.75rem;
    font: inherit;
    cursor: pointer;
  }
  button.primary {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: #fff;
  }
  button.ghost {
    background: #f8fafc;
  }
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
