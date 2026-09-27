/** Registers every command of the web UI. */
import { registerPartCommands } from "./part";
import { registerPartDesignCommands } from "./partdesign";
import { registerSketcherCommands } from "./sketcher";
import { registerStdCommands } from "./std";
import { registerCommands } from "./registry";

let done = false;

export function registerAllCommands(): void {
  if (done) return;
  done = true;
  registerStdCommands();
  registerPartCommands();
  registerPartDesignCommands();
  registerSketcherCommands();
  // Group commands (toolbar drop-downs) that exist only as groups.
  registerCommands([
    {
      id: "Std_ViewGroup",
      items: ["Std_ViewIsometric", "Std_ViewFront", "Std_ViewTop", "Std_ViewRight", "Std_ViewRear", "Std_ViewBottom", "Std_ViewLeft"],
    },
  ]);
}
