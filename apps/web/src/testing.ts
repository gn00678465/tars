import { PROTOCOL_VERSION, type ServerMessage } from "@tars/protocol";
import { act, createElement, type ReactNode } from "react";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./components/ui/message-scroller.tsx";
import { Socket, type SocketDeps, type WebSocketLike } from "./socket.ts";
import type { Event } from "./state.ts";

/** A WebSocket the test drives: it opens, answers and closes only when told. */
export class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
  /** What the page sent, parsed; "ping" is left out. */
  messages(): { id: string; kind: string; conv?: string; p: Record<string, unknown> }[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as never);
  }
  receive(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  /** Opens, then answers the page's hello the way the local end does. */
  ready(epoch = "epoch-1") {
    if (!this.messages().some((m) => m.kind === "hello")) this.onopen?.();
    const hello = this.messages().findLast((m) => m.kind === "hello");
    this.receive({
      v: PROTOCOL_VERSION,
      id: "s-hello",
      kind: "hello",
      re: hello?.id,
      p: { epoch, tars: "0.0.1" },
    });
  }
  end(code: number) {
    this.onclose?.({ code });
  }
}

export interface Harness {
  readonly socket: Socket;
  readonly sockets: FakeWebSocket[];
  readonly events: Event[];
  readonly fetches: string[];
  /** What the same-origin request answers. */
  answer: () => Promise<{ type: string; status: number }>;
  last(): FakeWebSocket;
  advance(ms: number): Promise<void>;
  now: () => number;
}

/** A Socket on fake sockets, timers and fetch. */
export function socketHarness(): Harness {
  let t = 0;
  let n = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeWebSocket[] = [];
  const events: Event[] = [];
  const fetches: string[] = [];
  const h: Harness = {
    sockets,
    events,
    fetches,
    answer: async () => ({ type: "basic", status: 200 }),
    last: () => sockets.at(-1) as FakeWebSocket,
    now: () => t,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, e]) => e.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        queue.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await Promise.resolve();
      }
      t = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    socket: undefined as unknown as Socket,
  };
  const deps: SocketDeps = {
    url: "wss://app.example.test/ws",
    open: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    fetch: async (url) => {
      fetches.push(url);
      return h.answer();
    },
    setTimeout: (fn, ms) => {
      const id = ++n;
      queue.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => void queue.delete(id as number),
    newId: () => `id-${++n}`,
    now: () => t,
  };
  const socket = new Socket(deps);
  socket.listener = (e) => void events.push(e);
  (h as { socket: Socket }).socket = socket;
  return h;
}

let seq = 0;
/** A server message as the local end or the relay would send it. */
export const server = (
  kind: ServerMessage["kind"],
  p: unknown,
  extra: { conv?: string; re?: string } = {},
) => ({ v: PROTOCOL_VERSION, id: `s-${++seq}`, kind, ...extra, p }) as ServerMessage;

/**
 * Waits for the next animation frame: Base UI moves the focus into a popup it opened on one, so a
 * test that checks where the focus is waits for it.
 */
export const frame = () =>
  act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));

/** Lets React, Base UI's effects and Lit's microtasks settle. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/**
 * A press as a pointer makes it. Base UI acts on the whole sequence, and click alone does not
 * open its popups reliably (m4_web_stack_design.md 5.5).
 */
export async function press(el: Element) {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const init = { bubbles: true, cancelable: true, button: 0 };
      el.dispatchEvent(
        type.startsWith("pointer")
          ? new PointerEvent(type, { ...init, pointerType: "mouse" })
          : new MouseEvent(type, init),
      );
    }
  });
  await settle();
}

/**
 * Types into a combobox as a person would: a press opens it, then the text arrives as an
 * InputEvent. The value goes through the element's own setter, past React's tracker.
 */
export async function typeInto(input: HTMLInputElement, text: string) {
  await press(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }),
    );
  });
  await settle();
}

/** An option's label: AccountSelect marks it, as its row shows the value under it too. */
const labelOf = (o: Element) =>
  (o.querySelector('[data-part="label"]') ?? o).textContent?.trim() ?? "";

/** The options an open combobox lists, by their labels. Its popup is under document.body. */
export const listed = () => [...document.querySelectorAll('[role="option"]')].map(labelOf);

/** Picks a listed option by its label. */
export async function choose(text: string) {
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => labelOf(o) === text);
  if (option === undefined) throw new Error(`no option ${text}; listed: ${listed().join(", ")}`);
  await press(option);
}

export interface Pt {
  y: number;
  x?: number;
  id?: number;
}
/** A touch event as the browser sends it: the targets and lists are all a handler reads. */
export function touch(el: Element, type: string, touches: Pt[], changed: Pt[] = touches) {
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
export function drag(el: Element, by: number, hold = false) {
  touch(el, "touchstart", [{ y: 100 }]);
  const moves = [0.25, 0.5, 0.75, 1].map((f) => touch(el, "touchmove", [{ y: 100 + by * f }]));
  if (!hold) touch(el, "touchend", [], [{ y: 100 + by }]);
  return moves;
}

/** The thread's rows are the scroller's (App.tsx): a test that draws Thread alone puts it in one. */
export const inScroller = (rows: ReactNode) =>
  createElement(
    MessageScrollerProvider,
    null,
    createElement(
      MessageScroller,
      null,
      createElement(
        MessageScrollerViewport,
        null,
        createElement(MessageScrollerContent, null, rows),
      ),
    ),
  );

/**
 * jsdom has no ResizeObserver or IntersectionObserver, and the scroller (@shadcn/react's Message
 * Scroller) follows a growing row by the first. Installed before the scroller mounts; `resize()`
 * is a layout change, which the scroller handles a frame later.
 */
export function observers() {
  const resized = new Set<ResizeObserverCallback>();
  const saved = { r: globalThis.ResizeObserver, i: globalThis.IntersectionObserver };
  class FakeResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe() {
      resized.add(this.cb);
    }
    unobserve() {}
    disconnect() {
      resized.delete(this.cb);
    }
  }
  class FakeIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver =
    FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  return {
    resize: async () => {
      for (const cb of resized) cb([], {} as ResizeObserver);
      await frame();
    },
    restore: () => {
      globalThis.ResizeObserver = saved.r;
      globalThis.IntersectionObserver = saved.i;
    },
  };
}

const box = (top: number, height: number) =>
  ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;

/**
 * jsdom lays nothing out: the scroller's viewport is `viewPx` tall and its rows are stacked, each
 * `rowPx` tall, so where a row is and how far the end is are what a browser would say. scrollTop
 * stays within what can be scrolled, as in a browser, and scrollTo moves at once and fires scroll.
 */
export function layout(viewport: HTMLElement, viewPx: number, rowPx: (row: HTMLElement) => number) {
  const content = viewport.querySelector('[data-slot="message-scroller-content"]') as HTMLElement;
  const rows = () =>
    [...content.children].filter((e): e is HTMLElement => !(e as HTMLElement).hidden);
  const total = () => rows().reduce((n, r) => n + rowPx(r), 0);
  const clamp = (v: number) => Math.min(Math.max(0, v), Math.max(0, total() - viewPx));
  let top = 0;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => viewPx },
    scrollHeight: { configurable: true, get: () => Math.max(total(), viewPx) },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = clamp(v);
      },
    },
    scrollTo: {
      configurable: true,
      value: (o: ScrollToOptions) => {
        top = clamp(o.top ?? top);
        viewport.dispatchEvent(new Event("scroll"));
      },
    },
    getBoundingClientRect: { configurable: true, value: () => box(0, viewPx) },
  });
  // Called with .call(this) below.
  // oxlint-disable-next-line typescript/unbound-method
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.parentElement !== content) return original.call(this);
    let y = -top;
    for (const r of rows()) {
      if (r === this) return box(y, rowPx(r));
      y += rowPx(r);
    }
    return box(0, 0);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
    for (const k of [
      "clientHeight",
      "scrollHeight",
      "scrollTop",
      "scrollTo",
      "getBoundingClientRect",
    ])
      delete (viewport as unknown as Record<string, unknown>)[k];
  };
}
