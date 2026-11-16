import { mount } from "svelte";
import App from "./App.svelte";
import "@fontsource-variable/inter";
import "./style.css";
import "./theme.css";

const target = document.getElementById("app");
if (!target) throw new Error("Elemento radice dell’interfaccia non trovato.");
mount(App, { target });
