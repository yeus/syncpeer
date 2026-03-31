<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title?: string;
    children?: Snippet;
  }

  let { title = "", children }: Props = $props();
</script>

<section class="panel">
  {#if title}
    <h2 class="heading">{title}</h2>
  {/if}
  {@render children?.()}
</section>

<style>
  .heading {
    margin-bottom: 0.45rem;
  }
</style>
