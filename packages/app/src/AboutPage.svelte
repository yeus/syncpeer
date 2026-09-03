<svelte:options runes={true} />
<script lang="ts">
  import {
    formatAppBuildInfo,
    formatBuildTimeLocal,
    getAppBuildInfo,
  } from "./lib/appInfo.ts";

  interface Props {
    onBack: () => void;
  }

  let { onBack }: Props = $props();
  const appInfo = getAppBuildInfo();
  const supportSummary = formatAppBuildInfo(appInfo);
  const buildTimeLocal = formatBuildTimeLocal(appInfo.buildTimeUtc);
  let copiedNotice = $state("");
  let copyError = $state("");

  const copyBuildInfo = async (): Promise<void> => {
    copiedNotice = "";
    copyError = "";
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      copyError = "Clipboard API unavailable on this device.";
      return;
    }
    try {
      await navigator.clipboard.writeText(supportSummary);
      copiedNotice = "Copied build information.";
    } catch (error) {
      copyError = error instanceof Error ? error.message : String(error);
    }
  };
</script>

<main class="about-page" data-testid="about-page">
  <header class="about-header">
    <button class="ghost" data-testid="about-back" onclick={onBack}>Back To Main App</button>
    <h1 class="about-title">About Syncpeer</h1>
  </header>

  <section class="panel about-panel">
    <p class="hint">
      Build and runtime information helps identify the exact app instance involved in a report.
      Values marked <code>unknown</code> were not available when the app was built.
    </p>

    <dl class="info-grid">
      <div>
        <dt>Application</dt>
        <dd data-testid="about-application">{appInfo.appName}</dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd data-testid="about-version">{appInfo.appVersion}</dd>
      </div>
      <div>
        <dt>Core version</dt>
        <dd data-testid="about-core-version">{appInfo.coreVersion}</dd>
      </div>
      <div>
        <dt>Commit</dt>
        <dd data-testid="about-commit"><code>{appInfo.buildCommit}</code></dd>
      </div>
      <div>
        <dt>Build time (UTC)</dt>
        <dd data-testid="about-build-time-utc">{appInfo.buildTimeUtc}</dd>
      </div>
      <div>
        <dt>Build time (local)</dt>
        <dd data-testid="about-build-time-local">{buildTimeLocal}</dd>
      </div>
      <div>
        <dt>Runtime</dt>
        <dd data-testid="about-runtime">{appInfo.runtimeEnvironment}/{appInfo.runtimeSurface}</dd>
      </div>
      <div>
        <dt>Platform</dt>
        <dd data-testid="about-platform">{appInfo.platform}</dd>
      </div>
      <div>
        <dt>Architecture</dt>
        <dd data-testid="about-architecture">{appInfo.architecture}</dd>
      </div>
      <div>
        <dt>Build mode</dt>
        <dd data-testid="about-build-mode">{appInfo.buildMode}</dd>
      </div>
    </dl>
  </section>

  <section class="panel about-panel">
    <h2 class="heading">Support summary</h2>
    <p class="hint">
      This summary contains build and coarse runtime metadata only. It does not include device IDs,
      folder names, network addresses, paths, or credentials.
    </p>
    <textarea
      class="support-summary"
      data-testid="about-support-summary"
      readonly
      value={supportSummary}
    ></textarea>
    <div class="actions">
      <button class="primary" data-testid="about-copy" onclick={copyBuildInfo}>Copy Build Information</button>
    </div>
    {#if copiedNotice}
      <div class="success" data-testid="about-copy-notice">{copiedNotice}</div>
    {/if}
    {#if copyError}
      <div class="error" data-testid="about-copy-error">{copyError}</div>
    {/if}
  </section>
</main>

<style>
  .about-page {
    max-width: 980px;
    margin: 0 auto;
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
  }

  .about-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .about-title {
    font-size: 1.15rem;
    margin: 0;
  }

  .about-panel {
    display: grid;
    gap: 0.75rem;
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.65rem;
    margin: 0;
  }

  .info-grid div {
    min-width: 0;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  dt {
    color: var(--text-muted);
    font-size: 0.74rem;
  }

  dd {
    margin: 0.2rem 0 0;
    overflow-wrap: anywhere;
    font-size: 0.88rem;
  }

  .support-summary {
    width: 100%;
    min-height: 13rem;
    resize: vertical;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .success {
    color: var(--state-success-text);
    font-size: 0.82rem;
  }

  .error {
    color: var(--state-danger-text);
    font-size: 0.82rem;
  }
</style>
