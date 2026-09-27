/**
 * Entry point: registers the commands, connects to the backend the URL names (see
 * `backend/connect.ts`) and renders the main window.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { autoConnect, connectTo } from "./backend/controller";
import { errorText } from "./commands/actions";
import { makeContext } from "./commands/context";
import { registerAllCommands } from "./commands/index";
import { runCommand, setCommandErrorSink } from "./commands/registry";
import { useApp } from "./state/app";
import { log, useConsole } from "./state/console";
import { useSelection } from "./state/selection";
import { conn, useSession } from "./state/session";
import { useView3D } from "./state/view3d";
import { App } from "./ui/App";
import "./styles.css";

registerAllCommands();
setCommandErrorSink((id, e) => log.error(`${id}: ${errorText(e)}`));

// Debug and test hook (the e2e suites drive the app through it as well as through the DOM).
(window as unknown as { __fabcad: unknown }).__fabcad = {
  run: (id: string) => runCommand(id, makeContext()),
  conn,
  connectTo,
  stores: { app: useApp, session: useSession, selection: useSelection, console: useConsole, view3d: useView3D },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void autoConnect();
