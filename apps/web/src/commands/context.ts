/** Builds the `CommandContext` commands see, from the stores. */
import { useApp } from "../state/app";
import { useSelection } from "../state/selection";
import { object, objects, useSession } from "../state/session";
import type { CommandContext } from "./registry";

export function makeContext(): CommandContext {
  const app = useApp.getState();
  const session = useSession.getState();
  const doc = app.activeDoc && session.conn?.store.document(app.activeDoc) ? app.activeDoc : null;
  return {
    connected: session.status === "connected" && !!session.conn,
    doc,
    selection: useSelection.getState().selection.filter((s) => !doc || s.doc === doc),
    editing: app.editing,
    taskOpen: !!app.task,
    workbench: app.workbench,
    undo: doc ? (session.undo[doc] ?? null) : null,
    objects: (d) => objects(d === undefined ? doc : d),
    object: (name, d) => object(d === undefined ? doc : d, name),
  };
}
