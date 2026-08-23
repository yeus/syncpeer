import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/styles/tokens.css";
import "./lib/styles/base.css";

if (__SYNCPEER_LAN_E2E__) {
  await import("@wdio/tauri-plugin");
}

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
