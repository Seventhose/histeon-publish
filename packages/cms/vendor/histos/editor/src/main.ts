import { mount } from 'svelte';
import App from './App.svelte';
import { readConfig } from './lib/config.ts';

const target = document.getElementById('xb-builder');
if (target) mount(App, { target, props: { config: readConfig() } });
