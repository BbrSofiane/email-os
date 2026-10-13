import { createApp } from 'vue';
import App from './App.vue';
import './assets/style.css';
import { selectMailClient } from './lib/ipc';

const { client, mode } = selectMailClient();
createApp(App, { client, mode }).mount('#app');
