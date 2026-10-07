import type * as VSCode from "vscode";
import { Sessions, type SessionRecord } from "./sessions";
import { errorMessage } from "./protocol";

type Group = VSCode.ChatSessionProviderOptionGroup;
type State = VSCode.ChatSessionInputState;
interface Binding {
  resource: string;
  record: SessionRecord;
}
interface ManagedState {
  state: State;
  binding?: Binding;
  published: readonly Group[];
  revision?: number;
  observed: Map<string, string | undefined>;
  subscriptions: VSCode.Disposable[];
}

const MARKER = "opencode_session";
const UNCONFIGURED = "unconfigured";
const UNAVAILABLE = "local_unavailable";
const SELECTORS = [{ id: "model", name: "Model" }, { id: "mode", name: "Agent" }, { id: "effort", name: "Reasoning" }];
const encode = (value: string) => Buffer.from(value, "utf16le").toString("hex");
const ownerFor = (resource: string) => `r_${encode(resource)}`;
const groupFor = (binding: Binding, id: string) => `${ownerFor(binding.resource)}_${id}`;
// Revision-scoped local IDs make delayed host echoes miss the new catalog's membership.
const choiceFor = (value: string, revision: number) => `v_${encode(value)}_${revision}`;

/** Owns the controller-wide union; ownership never comes from the broadcast marker. */
export function registerSessionOptions(
  controller: VSCode.ChatSessionItemController,
  backend: Sessions,
  load: (resource: VSCode.Uri, token: VSCode.CancellationToken) => Promise<SessionRecord>,
  showError: (message: string) => unknown,
) {
  const bindings = new Map<string, Binding>();
  const managed = new Map<State, ManagedState>();
  const pendingSelections = new WeakMap<SessionRecord, { groupId: string; itemId: string }>();

  function ownGroups(binding: Binding): Group[] {
    const { record } = binding;
    const locked = Boolean(record.turn || record.loading || record.configPending || !record.configValid);
    return SELECTORS.flatMap(({ id, name }) => {
      const option = record.configOptions.find((entry) => entry.id === id);
      const items: VSCode.ChatSessionProviderOptionItem[] = [];
      for (const entry of option?.options ?? []) {
        const choices = "group" in entry ? entry.options : [entry];
        for (const choice of choices) {
          items.push({ id: choiceFor(choice.value, record.configRevision), name: choice.name, description: choice.description ?? undefined });
        }
      }
      if (id === "effort" && !items.length) return [];
      const current = option && items.find((item) => item.id === choiceFor(option.currentValue, record.configRevision));
      let selected: VSCode.ChatSessionProviderOptionItem;
      if (record.configValid && current) {
        selected = { ...current, locked };
        items[items.indexOf(current)] = selected;
      } else {
        const unavailable = record.configValid && option ? `Unavailable: ${option.currentValue}` : "Configuration unavailable";
        selected = { id: UNAVAILABLE, name: unavailable, locked: true };
        items.push(selected);
      }
      return [{ id: groupFor(binding, id), name, description: option?.description ?? undefined, items, selected,
        when: `chatSessionOption.${MARKER} == '${ownerFor(binding.resource)}'` }];
    });
  }

  function groupsFor(binding?: Binding): Group[] {
    const groups = [...bindings.values()].flatMap((entry) => ownGroups(entry).map((group) => ({
      ...group, selected: entry === binding ? group.selected : undefined,
    })));
    const items = [UNCONFIGURED, ...[...bindings.keys()].map(ownerFor)].map((id) => ({ id, name: "OpenCode session", locked: true }));
    groups.push({ id: MARKER, name: "OpenCode session", when: "false", items,
      selected: items.find((item) => item.id === (binding ? ownerFor(binding.resource) : UNCONFIGURED)) });
    return groups;
  }

  function synchronize(entry: ManagedState, groups: readonly Group[]) {
    entry.published = groups;
    entry.revision = entry.binding?.record.configRevision;
    entry.observed = new Map(groups.map((group) => [group.id, group.selected?.id]));
  }

  function publish(entry: ManagedState) {
    const groups = groupsFor(entry.binding);
    // Set observations before the host can echo this resource's selections to all states.
    synchronize(entry, groups);
    entry.state.groups = groups;
  }

  function refresh() {
    for (const entry of managed.values()) publish(entry);
  }

  function reject(entry: ManagedState, message: string) {
    showError(`[OpenCode configuration] ${message}`);
    publish(entry);
  }

  function changed(entry: ManagedState) {
    const binding = entry.binding;
    if (!binding) {
      if (entry.state.groups.find((group) => group.id === MARKER)?.selected?.id !== UNCONFIGURED) publish(entry);
      return;
    }
    const { record } = binding;
    for (const { id } of SELECTORS) {
      const groupId = groupFor(binding, id);
      const group = entry.state.groups.find((item) => item.id === groupId);
      const previous = entry.published.find((item) => item.id === groupId);
      if (!group && !previous) continue;
      const itemId = group?.selected?.id;
      if (itemId === entry.observed.get(groupId)) continue;
      // The host fires unrelated events and duplicates one choice in multiple states.
      const pendingSelection = pendingSelections.get(record);
      if (pendingSelection?.groupId === groupId && pendingSelection.itemId === itemId) continue;
      entry.observed.set(groupId, itemId);
      if (!group || group.items !== previous?.items || entry.revision !== record.configRevision) {
        reject(entry, `Stale selection sessionId=${record.id}`);
        return;
      }
      const option = record.configOptions.find((item) => item.id === id);
      const choices = option?.options.flatMap((item) => "group" in item ? item.options : [item]) ?? [];
      const choice = choices.find((item) => choiceFor(item.value, record.configRevision) === itemId);
      if (typeof itemId !== "string" || !record.configValid || !choice || !group.items.some((item) => item.id === itemId)) {
        reject(entry, `Unavailable selection sessionId=${record.id} configId=${id}`);
        return;
      }
      if (choice.value === option?.currentValue) continue;
      if (record.turn || record.configPending || record.loading) {
        reject(entry, `Configuration busy sessionId=${record.id}`);
        return;
      }
      pendingSelections.set(record, { groupId, itemId });
      void backend.setConfigOption(record, id, choice.value, entry.revision ?? record.configRevision)
        .catch((error: unknown) => { showError(`[OpenCode configuration] sessionId=${record.id}: ${errorMessage(error)}`); })
        .finally(() => {
          pendingSelections.delete(record);
          refresh();
        });
      return;
    }
  }

  controller.getChatSessionInputState = async (resource, _context, token) => {
    let binding: Binding | undefined;
    if (resource && !resource.path.startsWith("/untitled-")) {
      const record = await load(resource, token);
      const key = resource.toString();
      binding = bindings.get(key) ?? { resource: key, record };
      bindings.set(key, binding);
    }
    const groups = groupsFor(binding);
    const state = controller.createChatSessionInputState(groups);
    const entry: ManagedState = { state, binding, published: [], observed: new Map(), subscriptions: [] };
    synchronize(entry, groups);
    managed.set(state, entry);
    entry.subscriptions.push(state.onDidChange(() => changed(entry)), state.onDidDispose(() => {
      entry.subscriptions.forEach((subscription) => subscription.dispose());
      managed.delete(state);
      if (binding && ![...managed.values()].some((live) => live.binding === binding)) bindings.delete(binding.resource);
      refresh();
    }));
    return state;
  };

  backend.on("config", refresh);
  return {
    refresh,
    provide(resource: VSCode.Uri, record: SessionRecord | undefined, state?: State): VSCode.ChatSession["options"] {
      const entry = state && managed.get(state);
      if (entry) publish(entry);
      // Saved initial resolution needs resource-owned options as well as the catalog setter.
      const binding = record ? { resource: resource.toString(), record } : undefined;
      const own = binding ? ownGroups(binding) : [];
      return Object.fromEntries([...own.map((group) => [group.id, group.selected]),
        [MARKER, { id: binding ? ownerFor(binding.resource) : UNCONFIGURED, name: "OpenCode session", locked: true }]]);
    },
    dispose() {
      backend.off("config", refresh);
      for (const entry of managed.values()) entry.subscriptions.forEach((subscription) => subscription.dispose());
      managed.clear();
      bindings.clear();
    },
  };
}
