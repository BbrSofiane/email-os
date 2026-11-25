import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';

describe('fixture send transport', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2025-01-01T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const fake = createBrowserFakeMailClient();
    const draft = await fake.createDraft({ requestId: 'create', source: { kind: 'new_message' }, initialContent: { to: 'a@example.test', cc: '', subject: 'Subject', bodyText: 'Body' } });
    const command = { draftRef: draft.ref, revision: draft.revision, requestId: 'send' };
    return { fake, draft, command, send: fake.send! };
  }

  it('replays receipts and restores the exact draft on undo', async () => {
    const { fake, draft, command, send } = await setup();
    const original = await fake.getDraft(draft.ref);
    const receipt = await send.admit(command);
    expect(await send.admit(command)).toEqual(receipt);
    vi.advanceTimersByTime(4999);
    expect(await send.undo(receipt.operationId)).toEqual(draft.ref);
    expect(await fake.getDraft(draft.ref)).toEqual(original);
    vi.advanceTimersByTime(1);
    expect((await send.listActivity())[0]?.state).toBe('undone');
  });

  it('confirms after the hold', async () => {
    const { fake, draft, command, send } = await setup();
    expect(await fake.sendAvailable!()).toBe(true);
    const receipt = await send.admit(command);
    vi.advanceTimersByTime(5000);
    expect((await send.listActivity())[0]?.state).toBe('confirmed');
    expect(await send.admit(command)).toEqual({ ...receipt, state: 'confirmed', stateChangedAt: receipt.notBefore });
    await expect(fake.getDraft(draft.ref)).rejects.toBeDefined();
  });
  it('does not replay an unknown outcome', async () => {
    const { fake, command, send } = await setup();
    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'outcome_unknown';
    const receipt = await send.admit(command);
    vi.advanceTimersByTime(5000);
    expect((await send.listActivity())[0]?.state).toBe('unknown');
    await send.check();
    expect((await send.admit(command)).state).toBe('unknown');
    await expect(send.retry(receipt.operationId, 'retry')).rejects.toBeDefined();
    const copy = await send.copyUnknown(receipt.operationId, 'copy');
    expect(await send.copyUnknown(receipt.operationId, 'copy')).toEqual(copy);
    expect(copy.ref).not.toEqual(command.draftRef);
    expect((await fake.getDraft(copy.ref)).content).toEqual((await fake.getDraft(command.draftRef)).content);
    expect(await send.dismiss(receipt.operationId)).toBe(true);
    expect(await send.listActivity()).toHaveLength(0);
    expect((await fake.listDrafts()).map((draft) => draft.ref)).not.toContainEqual(command.draftRef);
    expect((await send.admit(command)).state).toBe('unknown');
    await expect(send.retry(receipt.operationId, 'retry-2')).rejects.toBeDefined();
  });
});
