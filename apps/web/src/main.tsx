import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { browserSocket } from "./socket.ts";
import "./styles.css";
import "./app.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <App socket={browserSocket()} now={() => performance.now()} />,
);
