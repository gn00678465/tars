// @vitest-environment jsdom
import { act, useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { PullIndicator } from "./components/PullIndicator.tsx";
import { render } from "./render.ts";
import { drag, socketHarness, touch } from "./testing.ts";
import { DAMPING, MAX_PX, REST_PX, SETTLE_MS, usePullToRefresh } from "./usePullToRefresh.ts";

/** A finger's way that moves the page past the rest. */
const PULL_PX = REST_PX / DAMPING + 20;

let unmount = () => undefined as void;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  unmount();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

function Page(p: { draft?: boolean; reload: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const moved = useRef<HTMLDivElement>(null);
  const state = usePullToRefresh(ref, {
    page: moved,
    draft: () => p.draft === true,
    reload: p.reload,
  });
  return (
    <div id="page" ref={moved}>
      <PullIndicator state={state} />
      <main ref={ref} className="thread-scroll">
        <p id="msg">訊息</p>
        <input id="field" />
        <button id="approve" type="button">
          核准
        </button>
        <pre>
          <code id="code">code</code>
        </pre>
        <div id="wide" className="wide">
          <span id="cell">cell</span>
        </div>
      </main>
    </div>
  );
}

async function page(p: { draft?: boolean } = {}) {
  const reload = vi.fn();
  const r = await render(<Page {...p} reload={reload} />);
  unmount = r.unmount;
  const at = (id: string) => r.root.querySelector(`#${id}`) as HTMLElement;
  const offset = () => at("page").style.getPropertyValue("--pull-y");
  return {
    reload,
    root: r.root,
    at,
    offset,
    scroller: r.root.querySelector("main") as HTMLElement,
  };
}

const settle = (ms = SETTLE_MS) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });
const lessMotion = () =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduced-motion") }));

const bar = (root: HTMLElement) => root.querySelector(".pull-indicator") as HTMLElement | null;
const shown = (root: HTMLElement) => {
  const b = bar(root);
  return b === null ? null : [b.dataset.pull, b.textContent];
};

test("the page follows the finger, damped and capped; past the rest 放開重新整理", async () => {
  const { root, at, offset } = await page();
  expect(bar(root)).toBeNull();
  const el = at("msg");
  touch(el, "touchstart", [{ y: 100 }]);
  const seen = [40, 100, REST_PX / DAMPING, 400].map((dy) => {
    const e = touch(el, "touchmove", [{ y: 100 + dy }]);
    return [e.defaultPrevented, offset(), bar(root)?.dataset.pull, bar(root)?.textContent];
  });
  expect(seen).toEqual([
    [true, `${40 * DAMPING}px`, "pulling", "下拉重新整理"],
    [true, `${100 * DAMPING}px`, "pulling", "下拉重新整理"],
    [true, `${REST_PX}px`, "ready", "放開重新整理"],
    [true, `${MAX_PX}px`, "ready", "放開重新整理"],
  ]);
  expect(bar(root)?.getAttribute("role")).toBe("status");
  touch(el, "touchcancel", [], [{ y: 500 }]);
});

test("let go past the rest: the page settles at it with 重新整理中… and the wheel, then reloads", async () => {
  const { reload, root, at, offset } = await page();
  drag(at("msg"), PULL_PX + 100, true);
  touch(at("msg"), "touchend", [], [{ y: 100 + PULL_PX + 100 }]);
  expect([offset(), ...(shown(root) ?? [])]).toEqual([`${REST_PX}px`, "busy", "重新整理中…"]);
  expect(bar(root)?.querySelector(".tars-sprite.wheel")).not.toBeNull();
  await settle(SETTLE_MS - 1);
  expect(reload).not.toHaveBeenCalled();
  await settle(1);
  expect(reload).toHaveBeenCalledTimes(1);
  // Settling, the page takes no new pull.
  drag(at("msg"), PULL_PX);
  expect(shown(root)).toEqual(["busy", "重新整理中…"]);
});

test("one box in every state: the wheel's place is kept, so the text does not move", async () => {
  const { root, at } = await page();
  const kids = () => [...(bar(root)?.children ?? [])].map((c) => c.className);
  drag(at("msg"), 40, true);
  const pulling = kids();
  touch(at("msg"), "touchmove", [{ y: 100 + PULL_PX }]);
  const ready = kids();
  touch(at("msg"), "touchend", [], [{ y: 100 + PULL_PX }]);
  expect([pulling, ready, kids()]).toEqual([
    ["tars-sprite pull-mark", "pull-text"],
    ["tars-sprite pull-mark", "pull-text"],
    ["tars-sprite wheel", "pull-text"],
  ]);
});

test("short of the rest and let go: the page eases back to 0, then nothing is drawn moved", async () => {
  const { reload, root, at, offset } = await page();
  drag(at("msg"), 60);
  expect([offset(), bar(root)?.dataset.pull]).toEqual(["0px", "back"]);
  await settle();
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
});

test("with less motion asked for: no easing, back to 0 at once and the reload straight away", async () => {
  lessMotion();
  const { reload, root, at, offset } = await page();
  drag(at("msg"), 60);
  expect([offset(), bar(root)?.dataset.pull]).toEqual(["0px", "idle"]);
  drag(at("msg"), PULL_PX);
  expect(offset()).toBe(`${REST_PX}px`);
  await settle(0);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("touchcancel eases the page back and does not reload", async () => {
  const { reload, root, at, offset } = await page();
  drag(at("msg"), PULL_PX, true);
  touch(at("msg"), "touchcancel", [], [{ y: 190 }]);
  expect([offset(), bar(root)?.dataset.pull]).toEqual(["0px", "back"]);
  touch(at("msg"), "touchend", [], [{ y: 190 }]);
  await settle();
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
});

test("the only style on the page is the moved element's --pull-y", async () => {
  const { root, at } = await page();
  drag(at("msg"), PULL_PX, true);
  expect([...root.querySelectorAll("[style]")].map((e) => [e.id, e.getAttribute("style")])).toEqual(
    [["page", `--pull-y: ${PULL_PX * DAMPING}px;`]],
  );
  touch(at("msg"), "touchcancel", [], [{ y: 190 }]);
});

test("a thread scrolled down, or a finger going up, is scrolling: nothing is taken", async () => {
  const { reload, root, at, scroller } = await page();
  // jsdom lays nothing out: scrollTop is whatever the test says.
  const scrolled = (top: number) =>
    Object.defineProperty(scroller, "scrollTop", { value: top, configurable: true });
  scrolled(40);
  expect(drag(at("msg"), PULL_PX + 20).some((e) => e.defaultPrevented)).toBe(false);
  scrolled(0);
  expect(drag(at("msg"), -(PULL_PX + 20)).some((e) => e.defaultPrevented)).toBe(false);
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
});

test("not from a field, a button, a code block or something scrolling sideways", async () => {
  const style = document.createElement("style");
  style.textContent = ".wide { overflow-x: auto; }";
  document.head.append(style);
  const { reload, root, at } = await page();
  const wide = at("wide");
  Object.defineProperties(wide, { scrollWidth: { value: 800 }, clientWidth: { value: 300 } });
  for (const id of ["field", "approve", "code", "cell"]) {
    expect(
      drag(at(id), PULL_PX + 20).some((e) => e.defaultPrevented),
      id,
    ).toBe(false);
    expect(shown(root), id).toEqual(["idle", ""]);
  }
  expect(reload).not.toHaveBeenCalled();
});

test("not while the keyboard is up, or behind an open overlay's mark", async () => {
  const { reload, root, at } = await page();
  at("field").focus();
  drag(at("msg"), PULL_PX + 20);
  at("field").blur();
  // What Base UI puts on the page root while one of its overlays is open (pull.ts measures it);
  // inert and aria-hidden take no input either.
  const behind = root.parentElement as HTMLElement;
  for (const [name, value] of [
    ["data-base-ui-inert", ""],
    ["inert", ""],
    ["aria-hidden", "true"],
  ] as const) {
    behind.setAttribute(name, value);
    expect(
      drag(at("msg"), PULL_PX + 20).some((e) => e.defaultPrevented),
      name,
    ).toBe(false);
    behind.removeAttribute(name);
  }
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
  // Taken off on closing: the pull works again.
  drag(at("msg"), PULL_PX + 20);
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
});

test("two fingers do not pull, and a second finger ends a pull", async () => {
  const { reload, root, at } = await page();
  const el = at("msg");
  touch(el, "touchstart", [{ y: 100 }, { y: 100, x: 200, id: 1 }]);
  touch(el, "touchmove", [{ y: 190 }, { y: 190, x: 200, id: 1 }]);
  touch(el, "touchend", [], [{ y: 190 }, { y: 190, x: 200, id: 1 }]);
  drag(el, PULL_PX + 20, true);
  touch(el, "touchstart", [{ y: 190 }, { y: 100, x: 200, id: 1 }], [{ y: 100, x: 200, id: 1 }]);
  touch(el, "touchend", [], [{ y: 190 }]);
  await settle();
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
});

test("with unsent text the pull says so, and letting go does nothing", async () => {
  const { reload, root, at } = await page({ draft: true });
  drag(at("msg"), PULL_PX + 20, true);
  expect(shown(root)).toEqual(["blocked", "有未送出的文字，先送出或清除"]);
  touch(at("msg"), "touchend", [], [{ y: 190 }]);
  await settle();
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
});

test("a mouse or trackpad does nothing: no bar is drawn", async () => {
  const { reload, root, at } = await page();
  const el = at("msg");
  for (const [type, y] of [
    ["pointerdown", 100],
    ["mousedown", 100],
    ["pointermove", 200],
    ["mousemove", 200],
    ["pointerup", 200],
    ["mouseup", 200],
  ] as const)
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y }));
    });
  act(() => {
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -300 }));
  });
  expect(bar(root)).toBeNull();
  expect(reload).not.toHaveBeenCalled();
});

test("in the app: the composer's unsent text blocks the pull, cleared it does not", async () => {
  vi.useRealTimers();
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  unmount = r.unmount;
  await act(async () => h.last().ready());
  const main = r.root.querySelector("main.thread-scroll") as HTMLElement;
  const workspace = r.root.querySelector(".workspace") as HTMLElement;
  // The bar is not on the page until a finger touches the thread: a desktop never has it.
  expect(bar(r.root)).toBeNull();
  const box = r.root.querySelector("#composer-input") as HTMLTextAreaElement;
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, text);
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
  type("還沒送出");
  box.blur();
  drag(main, 40, true);
  expect(shown(r.root)).toEqual(["blocked", "有未送出的文字，先送出或清除"]);
  // The workspace is what moves; the bar is in it, beside what it moves.
  expect(workspace.style.getPropertyValue("--pull-y")).toBe(`${40 * DAMPING}px`);
  expect(bar(r.root)?.parentElement).toBe(workspace);
  touch(main, "touchend", [], [{ y: 140 }]);
  type("");
  box.blur();
  drag(main, 40, true);
  expect(shown(r.root)).toEqual(["pulling", "下拉重新整理"]);
  touch(main, "touchcancel", [], [{ y: 140 }]);
});
