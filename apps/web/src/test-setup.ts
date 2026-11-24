// Every test file: the roots a test left mounted are unmounted (render.ts), and the open
// conversation App keeps in sessionStorage (App.tsx OPEN_KEY) does not carry into the next test.
// Node tests have no sessionStorage.
import { afterEach } from "vite-plus/test";
import { unmountAll } from "./render.ts";

afterEach(() => {
  unmountAll();
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});
