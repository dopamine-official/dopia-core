import { openDB } from "idb";
import { initialState, settle, type State } from "./engine";
let database: ReturnType<typeof openDB> | undefined;
export function withState<T>(operation: (state: State) => T): Promise<T> {
  database ??= openDB("dopia-preview-v1", 1, {
    upgrade(db) {
      db.createObjectStore("state");
    },
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database.then(async (db) => {
    // One transaction serializes account changes, room opens and turn starts across tabs.
    const tx = db.transaction("state", "readwrite");
    const state: State = (await tx.store.get("current")) ?? initialState();
    settle(state);
    try {
      const result = operation(state);
      await tx.store.put(state, "current");
      await tx.done;
      return structuredClone(result);
    } catch (error) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw error;
    }
  });
}
