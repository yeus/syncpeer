<li class="list-item">
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
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .list-item {
      grid-template-columns: 1fr;
    }

    .item-actions {
      justify-content: flex-start;
    }
  }
</style>
