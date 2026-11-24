// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useRef } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { App } from "./App.tsx";
import { PullIndicator } from "./components/PullIndicator.tsx";
import { render } from "./render.ts";
import { socketHarness } from "./testing.ts";
import { PULL_PX, usePullToRefresh } from "./usePullToRefresh.ts";

let unmount = () => undefined as void;
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

function Page(p: { draft?: boolean; off?: boolean; reload: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const state = usePullToRefresh(ref, {
    draft: () => p.draft === true,
    ...(p.off === undefined ? {} : { off: p.off }),
    reload: p.reload,
  });
  return (
    <>
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
    </>
  );
}

async function page(p: { draft?: boolean; off?: boolean } = {}) {
  const reload = vi.fn();
  const r = await render(<Page {...p} reload={reload} />);
  unmount = r.unmount;
  const at = (id: string) => r.root.querySelector(`#${id}`) as HTMLElement;
  return { reload, root: r.root, at, scroller: r.root.querySelector("main") as HTMLElement };
}

interface Pt {
  y: number;
  x?: number;
  id?: number;
}
/** A touch event as the browser sends it: the targets and lists are all a handler reads. */
function touch(el: Element, type: string, touches: Pt[], changed: Pt[] = touches) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = (ps: Pt[]) =>
    ps.map((p) => ({ identifier: p.id ?? 0, clientX: p.x ?? 100, clientY: p.y, target: el }));
  Object.defineProperties(e, {
    touches: { value: list(touches) },
    changedTouches: { value: list(changed) },
  });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}

/** One finger from y 100 down by `by`, in a few moves; let go unless `hold`. */
function drag(el: Element, by: number, hold = false) {
  touch(el, "touchstart", [{ y: 100 }]);
  const moves = [0.25, 0.5, 0.75, 1].map((f) => touch(el, "touchmove", [{ y: 100 + by * f }]));
  if (!hold) touch(el, "touchend", [], [{ y: 100 + by }]);
  return moves;
}

const bar = (root: HTMLElement) => root.querySelector(".pull-indicator") as HTMLElement | null;
const shown = (root: HTMLElement) => {
  const b = bar(root);
  return b === null ? null : [b.dataset.pull, b.textContent];
};

test("past the threshold and let go: 放開重新整理, then 重新整理中… with the wheel, then the reload", async () => {
  const { reload, root, at } = await page();
  expect(bar(root)).toBeNull();
  const moves = drag(at("msg"), PULL_PX + 20, true);
  expect(moves.every((e) => e.defaultPrevented)).toBe(true);
  expect(shown(root)).toEqual(["ready", "放開重新整理"]);
  expect(bar(root)?.getAttribute("role")).toBe("status");
  expect(reload).not.toHaveBeenCalled();
  touch(at("msg"), "touchend", [], [{ y: 100 + PULL_PX + 20 }]);
  expect(shown(root)).toEqual(["busy", "重新整理中…"]);
  expect(bar(root)?.querySelector(".tars-sprite.wheel")).not.toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(root.querySelectorAll("[style]")).toHaveLength(0);
});

test("the bar goes by steps, 下拉重新整理 below the threshold; let go there and nothing happens", async () => {
  const { reload, root, at } = await page();
  const el = at("msg");
  touch(el, "touchstart", [{ y: 100 }]);
  const steps = [12, 30, 60].map((dy) => {
    touch(el, "touchmove", [{ y: 100 + dy }]);
    return [bar(root)?.dataset.step, bar(root)?.textContent];
  });
  expect(steps).toEqual([
    ["1", "下拉重新整理"],
    ["2", "下拉重新整理"],
    ["3", "下拉重新整理"],
  ]);
  touch(el, "touchend", [], [{ y: 160 }]);
  expect(shown(root)).toEqual(["idle", ""]);
  expect(bar(root)?.dataset.step).toBeUndefined();
  expect(reload).not.toHaveBeenCalled();
});

test("touchcancel takes the bar back and does not reload", async () => {
  const { reload, root, at } = await page();
  drag(at("msg"), PULL_PX + 20, true);
  touch(at("msg"), "touchcancel", [], [{ y: 190 }]);
  expect(shown(root)).toEqual(["idle", ""]);
  touch(at("msg"), "touchend", [], [{ y: 190 }]);
  expect(reload).not.toHaveBeenCalled();
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

test("not while the keyboard is up, an overlay is open, or the app says off", async () => {
  const { reload, root, at } = await page();
  at("field").focus();
  drag(at("msg"), PULL_PX + 20);
  at("field").blur();
  const sheet = document.createElement("div");
  sheet.setAttribute("aria-modal", "true");
  document.body.append(sheet);
  drag(at("msg"), PULL_PX + 20);
  sheet.remove();
  // Base UI's modal popups mark the page behind them.
  at("msg").closest("main")?.parentElement?.setAttribute("aria-hidden", "true");
  drag(at("msg"), PULL_PX + 20);
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
  unmount();
  const off = await page({ off: true });
  drag(off.at("msg"), PULL_PX + 20);
  expect(off.reload).not.toHaveBeenCalled();
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
  expect(shown(root)).toEqual(["idle", ""]);
  expect(reload).not.toHaveBeenCalled();
});

test("with unsent text the pull says so, and letting go does nothing", async () => {
  const { reload, root, at } = await page({ draft: true });
  drag(at("msg"), PULL_PX + 20, true);
  expect(shown(root)).toEqual(["blocked", "有未送出的文字，先送出或清除"]);
  touch(at("msg"), "touchend", [], [{ y: 190 }]);
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
  const h = socketHarness();
  const r = await render(<App socket={h.socket} now={h.now} />);
  unmount = r.unmount;
  await act(async () => h.last().ready());
  const main = r.root.querySelector("main.thread-scroll") as HTMLElement;
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
  expect(bar(r.root)?.nextElementSibling).toBe(main);
  touch(main, "touchend", [], [{ y: 140 }]);
  type("");
  box.blur();
  drag(main, 40, true);
  expect(shown(r.root)).toEqual(["pulling", "下拉重新整理"]);
  touch(main, "touchend", [], [{ y: 140 }]);
});

test("the hook and the bar write no style: the CSP allows none, and the height is by class", () => {
  for (const f of ["usePullToRefresh.ts", "components/PullIndicator.tsx"]) {
    const src = readFileSync(join(import.meta.dirname, f), "utf8");
    expect(src, f).not.toMatch(/\bstyle\s*=|\.style\.|setProperty/);
  }
});
