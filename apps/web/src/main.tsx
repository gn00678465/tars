import { CSPProvider } from "@base-ui/react/csp-provider";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { browserSocket } from "./socket.ts";
import "./index.css";
import "./styles.css";
import "./app.css";

// The CSP has no 'unsafe-inline' for styles: Base UI would add a <style> for the one rule it
// needs, so index.css carries that rule instead (m4_web_stack_design.md 1.1).
createRoot(document.getElementById("root") as HTMLElement).render(
  <CSPProvider disableStyleElements>
    <App socket={browserSocket()} now={() => performance.now()} />
  </CSPProvider>,
);
