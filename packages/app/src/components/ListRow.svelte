<script lang="ts">
  export let peerLayout = false;
</script>

<li class:peer-layout={peerLayout} class="list-item">
  <div class="item-main">
    <slot />
  </div>
  <div class="item-actions">
    <slot name="actions" />
  </div>
</li>

<style>
  .list-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.35rem;
  }

  .item-main {
    min-width: 0;
  }

  .item-actions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    align-self: stretch;
    justify-content: flex-end;
    flex-wrap: nowrap;
    white-space: nowrap;
  }

  /* Peer cards have potentially long addresses and IDs. Give the details the
     full row, with a separate wrapping action row at every viewport width. */
  .list-item.peer-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.65rem;
  }

  .peer-layout .item-actions {
    min-width: 0;
    justify-content: flex-start;
    align-self: auto;
    flex-wrap: wrap;
    white-space: normal;
  }
</style>
