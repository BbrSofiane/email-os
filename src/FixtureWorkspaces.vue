<script setup lang="ts">
/** Disclosed in-app synthetic sessions. Native still mounts exactly one App. */
import { nextTick, onBeforeUnmount, ref } from 'vue';
import App from './App.vue';
import type { FixtureWorkspace } from './lib/fixture-workspaces';

const props = defineProps<{ sessions: readonly FixtureWorkspace[] }>();
if (props.sessions.length !== 2
  || new Set(props.sessions.map((s) => s.accountId)).size !== props.sessions.length
  || new Set(props.sessions.map((s) => s.client)).size !== props.sessions.length) {
  throw new Error('Fixture workspaces require two distinct account/client owners');
}
// Fixed owners for the mounted lifetime. Never swap a client's account on switch.
const sessions = [...props.sessions];
const activeId = ref(sessions[0]!.accountId);
const switching = ref(false);
const error = ref('');
const panels = new Map<string, HTMLElement>();
const apps = new Map<string, InstanceType<typeof App>>();
const focuses = new Map<string, HTMLElement>();
const scrolls = new Map<string, Array<{ el: HTMLElement; top: number; left: number }>>();
const titles = ref<Record<string, string>>({});
const originalTitle = document.title;
let disposed = false;
onBeforeUnmount(() => { disposed = true; document.title = originalTitle; });

function rememberFocus(id: string, event: FocusEvent): void {
  if (id === activeId.value && event.target instanceof HTMLElement) focuses.set(id, event.target);
}
function titleChanged(id: string, title: string): void {
  if (disposed) return;
  titles.value[id] = title;
  if (id === activeId.value) document.title = `${title} — Synthetic workspace`;
}
function otherAccount(id: string): FixtureWorkspace {
  return sessions.find((s) => s.accountId !== id)!;
}
async function switchTo(id: string): Promise<void> {
  if (switching.value || id === activeId.value || !sessions.some((s) => s.accountId === id)) return;
  switching.value = true;
  error.value = '';
  const oldId = activeId.value;
  const oldPanel = panels.get(oldId);
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && oldPanel?.contains(focused)) focuses.set(oldId, focused);
  try {
    // No account transition until every accepted save/recovery intent is ACKed.
    if (!(await apps.get(oldId)?.prepareWorkspaceSwitch())) {
      blocked(oldId);
      return;
    }
    if (disposed) return;
    scrolls.set(oldId, oldPanel ? [oldPanel, ...oldPanel.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.scrollTop !== 0 || el.scrollLeft !== 0)
      .map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft })) : []);
    activeId.value = id;
    switching.value = false;
    await nextTick();
    if (disposed) return;
    for (const { el, top, left } of scrolls.get(id) ?? []) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
    const saved = focuses.get(id);
    if (saved?.isConnected && !saved.closest('[inert]')) saved.focus({ preventScroll: true });
    else panels.get(id)?.focus({ preventScroll: true });
    document.title = `${titles.value[id] ?? sessions.find((s) => s.accountId === id)!.emailAddress} — Synthetic workspace`;
  } catch {
    // Never turn an unexpected transition failure into an account change.
    if (!disposed) blocked(oldId);
  } finally {
    if (!disposed) switching.value = false;
  }
}
/** Blocked switch: keep the owner active, tell the user, and give keyboard focus back to the editor. */
function blocked(ownerId: string): void {
  error.value = 'Account switch blocked: save or recover the current local draft first.';
  switching.value = false;
  void nextTick(() => {
    if (disposed || activeId.value !== ownerId) return;
    const saved = focuses.get(ownerId);
    if (saved?.isConnected && !saved.closest('[inert]')) saved.focus({ preventScroll: true });
  });
}
// The alert describes the last blocked attempt; any interaction with the active workspace supersedes it.
function dismissError(): void { if (!switching.value) error.value = ''; }
</script>

<template>
  <div class="fixture-workspaces">
    <header class="workspace-header">
      <p id="workspace-boundary">Synthetic in-app workspaces · memory only · not native tabs · no mailbox search on this build</p>
      <nav aria-label="Fixture accounts" aria-describedby="workspace-boundary" :aria-busy="switching">
        <button v-for="session in sessions" :key="session.accountId" type="button"
          :data-test="`switch-${session.accountId}`" :aria-current="activeId === session.accountId ? 'true' : undefined"
          :disabled="switching" @click="switchTo(session.accountId)">
          {{ session.emailAddress }}<span v-if="titles[session.accountId]"> · {{ titles[session.accountId]?.split(' — ').slice(0, -1).join(' — ') }}</span>
        </button>
      </nav>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="switching" role="status">Saving local draft before switching…</p>
    </header>
    <section v-for="session in sessions" :key="session.accountId" v-show="activeId === session.accountId"
      :ref="(el) => { if (el) panels.set(session.accountId, el as HTMLElement); }"
      class="workspace-panel" :data-workspace="session.accountId" :aria-label="session.emailAddress"
      @focusin="rememberFocus(session.accountId, $event)" @input.capture="dismissError" @click.capture="dismissError"
      :inert="activeId !== session.accountId || switching ? true : undefined" tabindex="-1">
      <App :ref="(el) => { if (el) apps.set(session.accountId, el as InstanceType<typeof App>); }"
        :client="session.client" mode="browser-preview" :active="activeId === session.accountId && !switching"
        :switch-account-label="otherAccount(session.accountId).emailAddress"
        @switch-account="switchTo(otherAccount(session.accountId).accountId)"
        @workspace-title="titleChanged(session.accountId, $event)" />
    </section>
  </div>
</template>
