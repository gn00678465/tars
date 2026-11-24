// Every test file: the open conversation App keeps in sessionStorage (App.tsx OPEN_KEY) does not
// carry into the next test. Node tests have no sessionStorage.
import { afterEach } from "vite-plus/test";

afterEach(() => {
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});
