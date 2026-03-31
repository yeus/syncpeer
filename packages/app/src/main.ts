import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/styles/tokens.css";
import "./lib/styles/base.css";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
