// Registers happy-dom as the global DOM for `bun test` (preloaded through bunfig.toml).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
