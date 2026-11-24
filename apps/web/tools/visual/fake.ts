// The scene page's local end: a WebSocket that answers the page from scenes.ts. run.ts puts it
// before main.tsx in a build of its own; the app's build never has it.
import { PROTOCOL_VERSION } from "@tars/protocol";
import { EPOCH, SCENES, type Push, type Scene } from "./scenes.ts";

const n = Number(new URLSearchParams(location.search).get("scene") ?? "1");
const scene = SCENES[n - 1];
if (scene === undefined) throw new Error(`no scene ${n}`);

let seq = 0;
/** What the page sent, for csp.ts to read back. */
const sent: unknown[] = [];
(globalThis as { visualSent?: unknown[] }).visualSent = sent;
const envelope = (m: Push, re?: string) => ({ v: PROTOCOL_VERSION, id: `s-${++seq}`, re, ...m });

class SceneSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
    // For csp.ts: a push after the page is drawn, as the local end sends a new approval.
    (globalThis as { visualPush?: (m: Push) => void }).visualPush = (m) => this.reply(m);
  }
  close() {}
  // A microtask, not a timer: the status line's round trip then reads the same in every run.
  private reply(m: Push, re?: string) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(envelope(m, re)) }));
  }
  send(data: string) {
    if (data === "ping" || scene === undefined) return;
    const m = JSON.parse(data) as {
      id: string;
      kind: string;
      conv?: string;
      p: { path?: string; before?: number };
    };
    sent.push(m);
    if (m.kind === "hello") {
      this.reply({ kind: "hello", p: { epoch: EPOCH, tars: "0.0.1" } }, m.id);
      this.reply({ kind: "relay.status", p: scene.relay });
      for (const p of scene.pushes ?? []) this.reply(p);
      return;
    }
    const answer = scene.answers[m.kind];
    if (typeof answer === "function") for (const r of answer(m)) this.reply(r, m.id);
    else if (answer !== undefined) for (const r of answer) this.reply(r, m.id);
    const s = scene.stream;
    if (s !== undefined && m.kind === "conv.open" && m.conv === s.conv && m.p.before === undefined)
      this.stream(s);
  }
  /** The reply by time, as the local end sends it: steps of 50–100 ms, the same in every run. */
  private stream(s: NonNullable<Scene["stream"]>) {
    let i = 0;
    let text = "";
    const tick = () => {
      if (i === s.chunks) {
        this.reply({
          kind: "item",
          conv: s.conv,
          p: {
            item: {
              seq: 502,
              turn: s.turn,
              kind: "assistant",
              text,
              truncated: false,
              state: "complete",
            },
          },
        });
        return;
      }
      const chunk = `第 ${i} 段串流文字接上來，${i % 6 === 5 ? "\n\n" : ""}`;
      text += chunk;
      this.reply({ kind: "delta", conv: s.conv, p: { turn: s.turn, text: chunk } });
      i += 1;
      setTimeout(tick, 50 + ((i * 37) % 51));
    };
    setTimeout(tick, 300);
  }
}

(globalThis as { WebSocket: unknown }).WebSocket = SceneSocket;
