/**
 * Viewport and contact-disclosure handling, moved verbatim out of App.vue: the
 * narrow contact disclosure's open state and its three focus targets, the
 * `(min-width: 1000px)` media query and the reactive `wideViewport` flag, the
 * focus handoff when the viewport crosses the breakpoint, and the disclosure's
 * toggle and close. The owner registers the query's `change` listener in its
 * own mount hooks (it shares them with the keyboard listeners), so the query
 * and its handler are returned. What the disclosure needs from the shell
 * (the active workspace, the drawer, the two draft surfaces, the protected
 * editor release, whether the contact surface is collapsed) arrives as an
 * argument.
 */
import { nextTick, ref, type ComputedRef, type Ref } from 'vue';

/** Contact context breakpoint (supervisor-approved strict value). */
const CONTACT_BREAKPOINT_PX = 1000;

export interface ViewportContactDeps {
  workspaceActive: ComputedRef<boolean>;
  /** The utility drawer: opening the disclosure closes it. */
  drawer: Ref<string | null>;
  replyComposerOpen: Ref<boolean>;
  composeCardOpen: Ref<boolean>;
  /** Protected close of the active editor surface; false keeps it open. */
  releaseEditorSurface: () => Promise<boolean>;
  /** No contact surface exists (ready list with no rows): the disclosure cannot open. */
  contactCollapsed: ComputedRef<boolean>;
}

export function useViewportContact({ workspaceActive, drawer, replyComposerOpen, composeCardOpen, releaseEditorSurface, contactCollapsed }: ViewportContactDeps) {
  const contactDisclosure = ref(false);
  const contactPanelEl = ref<HTMLElement | null>(null);
  const contactDisclosureButton = ref<HTMLElement | null>(null);
  /** Wide contact surface: focus target when the narrow disclosure is removed. */
  const contactColumnEl = ref<HTMLElement | null>(null);

  const wideQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia(`(min-width: ${CONTACT_BREAKPOINT_PX}px)`)
    : null;
  const wideViewport = ref(wideQuery ? wideQuery.matches : true);

  function onViewportChange(event: MediaQueryListEvent): void {
    const wasWide = wideViewport.value;
    // Capture focus ownership BEFORE the template branches change: the wide
    // contact column and the narrow disclosure panel/trigger are all removed by
    // v-if as the reactive state updates, so ownership must be recorded first.
    const active = document.activeElement;
    const activeIsInWideContact = wasWide
      && active instanceof Node
      && (contactColumnEl.value?.contains(active) ?? false);
    const focusInNarrowContact = !wasWide && (
      (contactPanelEl.value instanceof HTMLElement && contactPanelEl.value.contains(active))
      || active === contactDisclosureButton.value
    );
    wideViewport.value = event.matches;
    if (wasWide && !event.matches) {
      // The pane becomes hidden content; keep keyboard focus out of it.
      contactDisclosure.value = false;
      void nextTick().then(() => {
        // Hand focus to the surviving narrow disclosure control only when the
        // wide contact surface owned focus; no focus theft when focus was
        // elsewhere (e.g. the list or a row).
        if (workspaceActive.value && activeIsInWideContact) contactDisclosureButton.value?.focus();
      });
    } else if (!wasWide && event.matches) {
      contactDisclosure.value = false;
      void nextTick().then(() => {
        if (workspaceActive.value && focusInNarrowContact) {
          // The disclosure and trigger no longer exist; hand focus to the
          // surviving wide contact surface instead of dropping it to the body.
          contactColumnEl.value?.focus();
        }
      });
    }
  }

  async function toggleContactDisclosure(): Promise<void> {
    if (wideViewport.value || contactCollapsed.value) return;
    // Leaving an active drafts editor must go through its protected lifecycle
    // rather than unmounting the editor silently; on failure it stays visible.
    if ((replyComposerOpen.value || composeCardOpen.value) && !contactDisclosure.value) {
      if (!(await releaseEditorSurface())) return;
    }
    // Disclosures are mutually exclusive: the contact disclosure replaces any
    // open utility drawer so the visible panel and keyboard owner agree.
    drawer.value = null;
    contactDisclosure.value = !contactDisclosure.value;
    void nextTick().then(() => {
      if (!workspaceActive.value) return;
      if (contactDisclosure.value) contactPanelEl.value?.focus();
      else contactDisclosureButton.value?.focus();
    });
  }

  async function closeContactDisclosure(): Promise<void> {
    contactDisclosure.value = false;
    await nextTick();
    if (workspaceActive.value) contactDisclosureButton.value?.focus();
  }
  return { contactDisclosure, contactPanelEl, contactDisclosureButton, contactColumnEl, wideQuery, wideViewport, onViewportChange, toggleContactDisclosure, closeContactDisclosure };
}
