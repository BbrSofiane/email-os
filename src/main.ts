import { createApp } from 'vue';
import StartupRoot from './StartupRoot.vue';
import './assets/style.css';
import './assets/mobile/tokens.css';
import './assets/mobile/shell.css';
import { isTauriRuntime, selectMailClient } from './lib/ipc';
import FixtureWorkspaces from './FixtureWorkspaces.vue';
import { createFixtureWorkspaces } from './lib/fixture-workspaces';

if (isTauriRuntime()) {
  const { client, mode } = selectMailClient();
  createApp(StartupRoot, { client, mode }).mount('#app');
} else {
  createApp(FixtureWorkspaces, { sessions: createFixtureWorkspaces() }).mount('#app');
}
import './assets/mobile/tokens.css';
import './assets/mobile/shell.css';
