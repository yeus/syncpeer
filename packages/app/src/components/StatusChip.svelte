<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    tone?: "online" | "offline" | "";
    small?: boolean;
    title?: string;
    children?: Snippet;
  }

  let { tone = "", small = false, title = "", children }: Props = $props();
</script>

<span class={`status-chip ${tone} ${small ? "small" : ""}`} {title}>
  {@render children?.()}
</span>
