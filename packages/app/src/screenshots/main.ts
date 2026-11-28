import { mount } from "svelte";
import ScreenshotApp from "./ScreenshotApp.svelte";
import "../lib/styles/tokens.css";
import "../lib/styles/base.css";

mount(ScreenshotApp, { target: document.getElementById("app")! });
