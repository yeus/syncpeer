import "./lib/browserCompatibility.js";
import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/styles/tokens.css";
import "./lib/styles/base.css";

const start = async () => {
  if (import.meta.env.SYNCPEER_LAN_E2E === true) await import("@wdio/tauri-plugin");
  return mount(App, { target: document.getElementById("app")! });
};

export default start();
