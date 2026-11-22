import { useEffect, useReducer, useRef, useState } from "react";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { ConversationList } from "./components/ConversationList.tsx";
import { StatusSheet, TopBar } from "./components/StatusBar.tsx";
import { timeText } from "./components/time.ts";
import { Thread } from "./components/Thread.tsx";
import type { Socket } from "./socket.ts";
import { composerBlocked, initial, localNow, reduce } from "./state.ts";

export function App({ socket, now }: { socket: Socket; now: () => number }) {
  const [state, dispatch] = useReducer(reduce, initial);
  const [tick, setTick] = useState(now);

  useEffect(() => {
    socket.listener = dispatch;
    socket.start();
    return () => socket.stop();
  }, [socket]);

  // The countdown on approval cards.
  useEffect(() => {
    const t = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(t);
  }, [now]);

  // After every hello (a reload, a reconnect, another epoch): the list and the open conversation.
  const { connection, conv } = state;
  useEffect(() => {
    if (connection !== "open") return;
    socket.send("conv.list");
    if (conv !== undefined) socket.send("conv.open", {}, conv);
    // conv is read, not watched: opening another conversation asks for it itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, socket]);

  // A new conversation followed from an ack: its start and first items were missed.
  const { load } = state;
  useEffect(() => {
    if (load !== undefined) socket.send("conv.open", {}, load);
  }, [load, socket]);

  // A turn that ended may have made or renamed a conversation.
  const ended = state.turn !== undefined && state.turn.state !== "started";
  useEffect(() => {
    if (ended) socket.send("conv.list");
  }, [ended, socket]);

  // The sidebar: a column that folds on desktop, a drawer below 1024px (ui_spec 5.1).
  const compact = useCompact();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  /** The reconnection the owner closed; a later one shows again. */
  const [seenReconnect, setSeenReconnect] = useState<number | undefined>(undefined);

  // A conversation opened from the list: the page goes to its thread.
  const thread = useRef<HTMLElement>(null);
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    if (opened > 0) thread.current?.focus();
  }, [opened]);

  const open = (c: string | undefined) => {
    dispatch({ type: "open_conv", conv: c });
    setDrawer(false);
    if (c === undefined) return;
    socket.send("conv.open", {}, c);
    setOpened((n) => n + 1);
  };
  const decide = (card: (typeof state.cards)[number], decision: "approved" | "denied") => {
    const id = socket.send("approval.decide", {
      approvalId: card.approval.approvalId,
      decision,
      hash: card.approval.hash,
    });
    dispatch(
      id === undefined
        ? { type: "decide_failed", approvalId: card.approval.approvalId }
        : { type: "deciding", approvalId: card.approval.approvalId, id },
    );
  };
  const oldest = state.items[0]?.seq;
  const running = state.turn?.state === "started" && state.conv !== undefined;
  const pending = state.cards.filter((c) => c.resolved === undefined);
  // In its own conversation a card is part of the thread, waiting or decided (ui_spec 5.4);
  // one waiting from another conversation is pinned above the composer, saying where it is from.
  const here = state.cards.filter((c) => c.approval.conv === state.conv);
  const settled = [
    ...here.filter((c) => c.resolved !== undefined).slice(-3),
    ...here.filter((c) => c.resolved === undefined),
  ];
  // From other conversations: the waiting ones, and the last three decided, so a decision made
  // here or elsewhere stays visible until closed.
  const elsewhere = state.cards.filter(
    (c) => c.approval.conv !== state.conv && !dismissed.has(c.approval.approvalId),
  );
  const pinned = [
    ...elsewhere
      .filter((c) => c.resolved !== undefined)
      .sort((a, b) => (a.decidedOrder ?? 0) - (b.decidedOrder ?? 0))
      .slice(-3),
    ...elsewhere.filter((c) => c.resolved === undefined),
  ];
  // One card on the page takes the focus: the oldest waiting one.
  const first = pending[0]?.approval.approvalId;
  const blocked =
    state.connection !== "open" || !state.relay.online ? "離線，無法送出決定" : undefined;
  const waiting = new Set(pending.map((c) => c.approval.conv));
  const titleOf = (id: string) => state.convs.find((c) => c.id === id)?.title || "另一個對話";
  const current = state.convs.find((c) => c.id === state.conv);

  return (
    <div className="app-viewport">
      <h1 className="sr-only">TARS 本機 Agent 遠端介面</h1>
      <div className="app-shell">
        <div
          className={drawer ? "drawer-scrim visible" : "drawer-scrim"}
          aria-hidden="true"
          onClick={() => setDrawer(false)}
        />
        <ConversationList
          convs={state.convs}
          listed={state.listed === true}
          offline={state.connection === "open" && !state.relay.online}
          current={state.conv}
          waiting={waiting}
          collapsed={collapsed && !compact}
          drawerOpen={drawer}
          onOpen={open}
          onCollapse={() => (compact ? setDrawer(false) : setCollapsed(true))}
        />
        <div className="workspace">
          <TopBar
            state={state}
            menuHidden={!collapsed && !compact}
            onMenu={() => (compact ? setDrawer(true) : setCollapsed(false))}
            onSheet={() => setSheet(true)}
          />
          {current === undefined ? null : (
            <div className="conv-header-bar">
              <div className="conv-header-info">
                <span className="conv-header-model">{current.model}</span>
                <span className="sg-tag">{current.provider}</span>
              </div>
            </div>
          )}
          {/* Outside the scrolling thread: it may mean another machine took the certificate. */}
          {state.reconnectedAt === undefined || state.reconnectedAt === seenReconnect ? null : (
            <div className="task-notice warn reconnect-alert" role="alert">
              <div className="task-notice-body">
                <div className="task-notice-title">
                  本機端在 {timeText(state.reconnectedAt)} 重新連上
                </div>
                <div className="task-notice-desc">如果不是你重啟的，請到 Cloudflare 檢查憑證。</div>
              </div>
              <button
                className="sg-btn sg-btn-sm"
                type="button"
                onClick={() => setSeenReconnect(state.reconnectedAt)}
              >
                知道了
              </button>
            </div>
          )}
          <main className="thread-scroll" ref={thread} tabIndex={-1} aria-label="訊息">
            <div className="thread-inner thread">
              <Thread
                state={state}
                onOlder={() => {
                  if (state.conv !== undefined && oldest !== undefined)
                    socket.send("conv.open", { before: oldest }, state.conv);
                }}
              />
              {settled.map((card) => (
                <ApprovalCard
                  key={card.approval.approvalId}
                  card={card}
                  localNow={localNow(state, tick)}
                  onDecide={(d) => decide(card, d)}
                  focus={card.approval.approvalId === first}
                  {...(blocked === undefined ? {} : { blocked })}
                />
              ))}
            </div>
          </main>
          <footer className="composer-dock">
            <div className="composer-wrap">
              <div className="pinned-approvals">
                {pinned.map((card) => (
                  <ApprovalCard
                    key={card.approval.approvalId}
                    card={card}
                    localNow={localNow(state, tick)}
                    onDecide={(d) => decide(card, d)}
                    focus={card.approval.approvalId === first}
                    {...(blocked === undefined ? {} : { blocked })}
                    origin={{
                      title: titleOf(card.approval.conv),
                      onJump: () => open(card.approval.conv),
                      ...(card.resolved === undefined
                        ? {}
                        : {
                            onDismiss: () =>
                              setDismissed((d) => new Set(d).add(card.approval.approvalId)),
                          }),
                    }}
                  />
                ))}
              </div>
              <Composer
                blocked={composerBlocked(state)}
                canAbort={running && state.connection === "open"}
                error={state.error}
                onSend={(text) => socket.submit(text, state.conv)}
                onAbort={() => {
                  if (state.conv !== undefined) socket.send("turn.abort", {}, state.conv);
                }}
              />
            </div>
          </footer>
        </div>
        {sheet ? <StatusSheet state={state} onClose={() => setSheet(false)} /> : null}
      </div>
    </div>
  );
}

const COMPACT = "(max-width: 1023px)";

/** Below 1024px the sidebar is a drawer. jsdom has no matchMedia: there it is a desktop. */
function useCompact(): boolean {
  const media = () =>
    typeof window.matchMedia === "function" ? window.matchMedia(COMPACT) : undefined;
  const [compact, setCompact] = useState(() => media()?.matches === true);
  useEffect(() => {
    const query = media();
    if (query === undefined) return;
    const change = () => setCompact(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return compact;
}
