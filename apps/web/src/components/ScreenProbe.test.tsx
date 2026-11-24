// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { render } from "../render.ts";
import { ScreenProbe } from "./ScreenProbe.tsx";

// jsdom has neither of these; every browser does.
beforeEach(() => {
  document.elementFromPoint = () => null;
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof matchMedia;
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Opens the details the way a tap does: the open attribute, then its toggle event. */
const openIt = async (root: HTMLElement) => {
  const details = root.querySelector("details");
  await act(async () => {
    details?.setAttribute("open", "");
    details?.dispatchEvent(new Event("toggle"));
  });
};

test("nothing is read until it is opened (the status sheet opens often)", async () => {
  document.elementFromPoint = () => {
    throw new Error("read before it was opened");
  };
  const { root } = await render(<ScreenProbe />);
  expect(root.querySelector(".screen-probe-out")?.textContent).toBe("");
});

test("the probes are portaled to <body> and the numbers are printed", async () => {
  const { root, unmount } = await render(<ScreenProbe />);
  await openIt(root);
  expect(document.body.querySelectorAll(":scope > .probe").length).toBe(7);
  expect(root.querySelector(".probe")).toBeNull();
  const out = root.querySelector(".screen-probe-out")?.textContent ?? "";
  for (const key of [
    "innerHeight",
    "100dvh",
    "env(safe-area-inset-bottom)",
    "env(safe-area-inset-top)",
    "visualViewport 高",
    "screen 寬×高",
  ])
    expect(out).toContain(key);
  expect(document.querySelector("[style]")).toBeNull();
  unmount();
  expect(document.body.querySelectorAll(".probe").length).toBe(0);
});

test("the red line at the screen's bottom edge is toggled by its button", async () => {
  const { root } = await render(<ScreenProbe />);
  expect(document.querySelector(".probe-line")).toBeNull();
  const toggle = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("紅線"));
  await act(async () => toggle?.click());
  expect(document.querySelector(".probe-line")).not.toBeNull();
  await act(async () => toggle?.click());
  expect(document.querySelector(".probe-line")).toBeNull();
});
