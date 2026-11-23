import { PROTOCOL_VERSION, type ServerMessage } from "@tars/protocol";
import { act } from "react";
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
