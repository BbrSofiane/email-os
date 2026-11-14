import { actionLabel as registryActionLabel, actionRegistry, type ActionId, type AvailableAction as RegistryAvailableAction } from './action-registry';

/** Frontend discovery only; execution still uses the named typed MailClient methods. Derived from the registry. */
export const browsingActions = actionRegistry.map(({ id, label, shortcut, aliases }) => ({ id, label, shortcut, aliases }));
export type BrowsingActionId = ActionId;
export type AvailableAction = RegistryAvailableAction;
export const actionLabel = registryActionLabel;
