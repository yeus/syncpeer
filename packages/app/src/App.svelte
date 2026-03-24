<script lang="ts">
  import { connectAndSync } from "@syncpeer/core";

  let host = "127.0.0.1";
  let port = 22000;
  let cert = "";
  let key = "";
  let remoteId = "";
  let deviceName = "syncpeer-ui";

  let remoteFs: any = null;
  let folders: Array<any> = [];
  let entries: Array<any> = [];
  let selectedFolderId = "";
  let error: string | null = null;

  async function connect() {
    error = null;
    try {
      remoteFs = await connectAndSync({
        host,
        port,
        cert: cert || undefined,
        key: key || undefined,
        expectedDeviceId: remoteId || undefined,
        deviceName,
      } as any);
      folders = await remoteFs.listFolders();
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
  }

  async function loadFolder(folderId: string) {
    if (!remoteFs) return;
    selectedFolderId = folderId;
    try {
      entries = await remoteFs.readDir(folderId, "");
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
  }
</script>

<style>
  header { padding: 1rem; background: #2d3748; color: white; }
  main { padding: 1rem; max-width: 800px; margin: 0 auto; }
  form { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 1rem; }
  label { display: flex; flex-direction: column; font-size: 0.9rem; }
  input { padding: 0.25rem; font-size: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  ul { list-style: none; padding-left: 0; }
  li { margin: 0.25rem 0; }
</style>

<header><h1>Syncpeer UI</h1></header>

<main>
  <form on:submit|preventDefault={connect}>
    <label>Host<input type="text" bind:value={host} /></label>
    <label>Port<input type="number" bind:value={port} /></label>
    <label>TLS Certificate (optional)<input type="text" bind:value={cert} placeholder="/path/to/cert.pem" /></label>
    <label>TLS Key (optional)<input type="text" bind:value={key} placeholder="/path/to/key.pem" /></label>
    <label>Remote Device ID (optional)<input type="text" bind:value={remoteId} placeholder="Device ID" /></label>
    <label>Device Name<input type="text" bind:value={deviceName} /></label>
    <button type="submit">Connect</button>
  </form>

  {#if error}<p style="color: red;">{error}</p>{/if}

  {#if folders.length > 0}
    <h2>Folders</h2>
    <ul>
      {#each folders as folder}
        <li><button on:click={() => loadFolder(folder.id)}>{folder.label || folder.id}</button></li>
      {/each}
    </ul>
  {/if}

  {#if selectedFolderId}
    <h2>Entries in {selectedFolderId}</h2>
    <ul>
      {#each entries as entry}
        <li>{entry.type} {entry.path}{entry.type === "directory" ? "/" : ""}</li>
      {/each}
    </ul>
  {/if}
</main>
