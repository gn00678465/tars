import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ApprovalCard, announceText } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { ContinueBanner, ModelSheet, type ModelRef } from "./components/ModelSheet.tsx";
import { ConversationList } from "./components/ConversationList.tsx";
import { providerSpend, StatusSheet, TopBar } from "./components/StatusBar.tsx";
import { shortTime, timeText } from "./components/time.ts";
import { PinnedDock } from "./components/PinnedDock.tsx";
import {
  clampEffort,
  type EffortControl,
  EffortSheet,
  effortName,
  RunSetup,
} from "./components/RunSetup.tsx";
import { Thread } from "./components/Thread.tsx";
import type { Socket } from "./socket.ts";
import { composerBlocked, initial, localNow, reduce, sendBusy } from "./state.ts";

/** Within this much of the end counts as at the bottom (rounding, a last line half shown). */
const BOTTOM_PX = 24;
/**
 * 往返延遲 is measured all the time, for the top bar: on connecting, every PING_MS, and again when
 * the status sheet opens or closes. Not more often: each status.get makes the local end total its budgets
 * (its skills it reads at most once a minute).
 */
const PING_MS = 30_000;
/** How long "from the next message" shows after a level is picked, as the prototype's toast. */
const TOAST_MS = 2_600;

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
  const compact = useMedia(COMPACT);
  const phone = useMedia(PHONE);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const live = state.connection === "open";
  useEffect(() => {
    if (!live) return;
    const ping = () => {
      const id = socket.send("status.get");
      if (id !== undefined) dispatch({ type: "pinged", id, at: now() });
    };
    ping();
    const t = setInterval(ping, PING_MS);
    return () => clearInterval(t);
  }, [sheet, live, socket, now]);
  // Each time the local end is reached: one that answers lists its models, and only then does
  // the page offer them. An older one answers bad_message, which no request waits on.
  useEffect(() => {
    if (live) socket.send("models.get");
  }, [live, socket]);
  /**
   * The next message's model, and the conversation it continues: for the new conversation the
   * page is on. Opening any conversation forgets it.
   */
  const [next, setNext] = useState<
    { model: ModelRef; from?: string; keepLast?: number } | undefined
  >(undefined);
  const [picking, setPicking] = useState<"new" | "continue" | undefined>(undefined);
  // The level picked for the next message here, kept until another conversation opens; the
  // menu; and the note that it applies from the next message, a new one each pick.
  const [effortPick, setEffortPick] = useState<string | undefined>(undefined);
  // The desktop model menu, and the model it picked to continue in, for the sheet to start on.
  const [modelOpen, setModelOpen] = useState(false);
  const [forkPick, setForkPick] = useState<ModelRef | undefined>(undefined);
  const [effortOpen, setEffortOpen] = useState(false);
  const [toast, setToast] = useState(0);
  useEffect(() => {
    if (toast === 0) return;
    const hide = setTimeout(() => setToast(0), TOAST_MS);
    return () => clearTimeout(hide);
  }, [toast]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  /** The reconnection the owner closed; a later one shows again. */
  const [seenReconnect, setSeenReconnect] = useState<number | undefined>(undefined);

  // A conversation opened from the list: the page goes to its thread.
  const thread = useRef<HTMLElement>(null);
  // Whether the owner was at the bottom before this render: then what came is followed. One who
  // scrolled up to read is left there.
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = thread.current;
    if (el !== null && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.running, state.turn, state.cards]);
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    if (opened > 0) thread.current?.focus();
  }, [opened]);

  // A card that comes to wait is announced once, assertively (the prototype's
  // approval-live-alert); the local end's resend of it after a reconnect is not new.
  const announced = useRef(new Set<string>());
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const waiting = state.cards.filter((c) => c.resolved === undefined);
    const fresh = waiting.filter((c) => !announced.current.has(c.approval.approvalId));
    for (const c of fresh) announced.current.add(c.approval.approvalId);
    const last = fresh.at(-1);
    if (last !== undefined) setAnnounce(announceText(last.approval));
    else if (waiting.length === 0) setAnnounce("");
  }, [state.cards]);

  // How many times a new conversation was started: until then the empty page greets; each one
  // gives the composer the focus (7-19).
  const [started, setStarted] = useState(0);
  const open = (c: string | undefined) => {
    setNext(undefined);
    setEffortPick(undefined);
    setEffortOpen(false);
    setModelOpen(false);
    dispatch({ type: "open_conv", conv: c });
    setDrawer(false);
    if (c === undefined) return setStarted((n) => n + 1);
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
        : { type: "deciding", approvalId: card.approval.approvalId, id, choice: decision },
    );
  };
  const oldest = state.items[0]?.seq;
  const running = state.turn?.state === "started" && state.conv !== undefined;
  const pending = state.cards.filter((c) => c.resolved === undefined);
  // In its own conversation a card is part of the thread, waiting or decided (ui_spec 5.4);
  // one waiting from another conversation is pinned above the composer, saying where it is from.
  const here = state.cards.filter((c) => c.approval.conv === state.conv);
  const byDecision = (cards: readonly (typeof state.cards)[number][]) =>
    cards
      .filter((c) => c.resolved !== undefined)
      .sort((a, b) => (a.decidedOrder ?? 0) - (b.decidedOrder ?? 0))
      .slice(-3);
  const settled = [...byDecision(here), ...here.filter((c) => c.resolved === undefined)];
  // A card is drawn under its tool call; without a callId (an older local end), after the item
  // that was last when it came. One whose item is not loaded goes at the end.
  const anchorOf = (c: (typeof settled)[number]) => {
    const { callId } = c.approval;
    if (callId === undefined) return c.after;
    return state.items.find((i) => i.kind === "tool_call" && i.callId === callId)?.seq;
  };
  const seqs = new Set(state.items.map((i) => i.seq));
  const anchored = new Map<number, typeof settled>();
  const loose: typeof settled = [];
  for (const c of settled) {
    const at = anchorOf(c);
    if (at === undefined || !seqs.has(at)) loose.push(c);
    else anchored.set(at, [...(anchored.get(at) ?? []), c]);
  }
  // From other conversations: the waiting ones, and the last three decided, so a decision made
  // here or elsewhere stays visible until closed.
  const elsewhere = state.cards.filter(
    (c) => c.approval.conv !== state.conv && !dismissed.has(c.approval.approvalId),
  );
  const pinned = [...byDecision(elsewhere), ...elsewhere.filter((c) => c.resolved === undefined)];
  // One card on the page takes the focus: the oldest one still to be decided, so it moves on
  // when that one is sent.
  const first = pending.find((c) => c.deciding === undefined && c.acked !== true)?.approval
    .approvalId;
  const blocked =
    state.connection !== "open" || !state.relay.online ? "離線，無法送出決定" : undefined;
  const waiting = new Set(pending.map((c) => c.approval.conv));
  const titleOf = (id: string) => state.convs.find((c) => c.id === id)?.title || "另一個對話";
  const current = state.convs.find((c) => c.id === state.conv);
  // Titles come from first messages, so two conversations can share one: the time and model tell
  // them apart. One past the list's 500 has only what the card itself carries.
  const originOf = (a: (typeof state.cards)[number]["approval"]) => {
    const c = state.convs.find((x) => x.id === a.conv);
    return c === undefined
      ? { title: "另一個對話", detail: `核准 ${a.hash.slice(0, 8)}` }
      : {
          title: c.title === "" ? "（沒有標題）" : c.title,
          detail: `${shortTime(c.updatedAt)} · ${c.model}`,
        };
  };
  const { models } = state;
  const modelOf = (r: ModelRef | undefined) =>
    r === undefined ? undefined : models?.find((m) => m.provider === r.provider && m.id === r.id);
  // A new conversation starts on the model of the one updated last, while the local end still
  // takes it; else on the local end's default (7-16). The list is the memory: no browser storage.
  const last = state.convs[0];
  const lastModel =
    last === undefined ? undefined : modelOf({ provider: last.provider, id: last.model });
  const preset =
    lastModel === undefined ||
    lastModel.unusable !== undefined ||
    providerSpend(state.status, lastModel.provider)?.stopped === true
      ? undefined
      : { model: { provider: lastModel.provider, id: lastModel.id } };
  const chosen: typeof next = state.conv === undefined ? (next ?? preset) : undefined;
  const currentRef =
    current === undefined ? undefined : { provider: current.provider, id: current.model };
  // The conversation a continuation comes from: this one, or the one the next message continues.
  const source = state.conv ?? chosen?.from;
  const sourceConv = state.convs.find((c) => c.id === source);
  const nextLabel =
    current !== undefined
      ? (modelOf(currentRef)?.label ?? current.model)
      : (modelOf(chosen?.model)?.label ?? models?.find((m) => m.isDefault)?.label ?? "預設");
  // The model the next message goes to, and the level it goes with: the one picked, else this
  // conversation's, else the one continued, else the model's own default; moved to the nearest
  // the model takes, as the local end would move it, and then sent, so the page says what runs.
  const target =
    current !== undefined
      ? modelOf(currentRef)
      : (modelOf(chosen?.model) ?? models?.find((m) => m.isDefault));
  const targetRef =
    currentRef ??
    chosen?.model ??
    (target === undefined ? undefined : { provider: target.provider, id: target.id });
  const spend = (provider: string) => providerSpend(state.status, provider);
  // With messages, another model is a continuation (D17).
  const pickModel = () => setPicking(source === undefined ? "new" : "continue");
  const levels = target?.effortLevels ?? [];
  const wanted =
    effortPick ??
    (current !== undefined
      ? current.effort
      : chosen?.from !== undefined
        ? sourceConv?.effort
        : target?.defaultEffort);
  const effortNow = clampEffort(levels, wanted);
  const movedFrom =
    wanted !== undefined && effortNow !== undefined && effortNow !== wanted ? wanted : undefined;
  // As the prototype: model and effort are not changed while a turn runs (it would apply to
  // nothing) or while the local end cannot be reached.
  const locked =
    running || sendBusy(state) !== undefined ? "回合結束後才能改" : composerBlocked(state);
  // Only a local end that lists levels takes turn.submit's effort.
  const effort: EffortControl | undefined =
    models?.some((m) => m.effortLevels !== undefined) === true
      ? {
          levels,
          current: effortNow,
          ...(movedFrom === undefined ? {} : { movedFrom }),
          ...(locked === undefined ? {} : { disabled: locked }),
          open: effortOpen,
          onOpen: setEffortOpen,
          onPick: (level) => {
            setEffortPick(level);
            dispatch({ type: "notices_done", code: "effort_clamped" });
            setEffortOpen(false);
            setToast((n) => n + 1);
          },
        }
      : undefined;
  const sendEffort =
    effort !== undefined && (effortPick !== undefined || movedFrom !== undefined)
      ? effortNow
      : undefined;
  const card = (c: (typeof settled)[number]) => (
    <ApprovalCard
      key={c.approval.approvalId}
      card={c}
      localNow={localNow(state, tick)}
      onDecide={(d) => decide(c, d)}
      focus={c.approval.approvalId === first}
      pageNow={tick}
      {...(blocked === undefined ? {} : { blocked })}
    />
  );

  return (
    <div className="app-viewport">
      <h1 className="sr-only">TARS 本機 Agent 遠端介面</h1>
      {/* Live regions are there before what they say, or a screen reader may miss it. */}
      <div className="sr-only" role="alert" aria-live="assertive">
        {announce}
      </div>
      <div className="sr-only" aria-live="polite">
        {state.spoken ?? ""}
      </div>
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
          drawerOpen={drawer && compact}
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
                {effort === undefined ? null : (
                  <span className="conv-header-effort">
                    推理：{effortNow === undefined ? "不適用" : effortName(effortNow)}
                  </span>
                )}
              </div>
              {models === undefined ? null : (
                <button
                  className="sg-btn sg-btn-ghost"
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => setPicking("continue")}
                >
                  以另一個模型接續
                </button>
              )}
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
          <main
            className="thread-scroll"
            ref={thread}
            tabIndex={-1}
            aria-label="訊息"
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_PX;
            }}
          >
            <div className="thread-inner thread">
              <Thread
                state={state}
                {...(models === undefined ? {} : { model: models.length === 0 ? "" : nextLabel })}
                welcome={
                  started === 0 &&
                  next === undefined &&
                  state.connection === "open" &&
                  state.relay.online
                }
                {...(effort === undefined || levels.length === 0
                  ? {}
                  : { onEffort: () => setEffortOpen(true) })}
                after={(seq) => anchored.get(seq)?.map(card)}
                onOlder={() => {
                  if (state.conv !== undefined && oldest !== undefined)
                    socket.send("conv.open", { before: oldest }, state.conv);
                }}
              />
              {loose.map(card)}
            </div>
          </main>
          <footer className="composer-dock">
            <div className="composer-wrap">
              {pinned.length === 0 ? null : (
                <PinnedDock count={pinned.length}>
                  {pinned.map((card) => (
                    <ApprovalCard
                      key={card.approval.approvalId}
                      card={card}
                      localNow={localNow(state, tick)}
                      onDecide={(d) => decide(card, d)}
                      focus={card.approval.approvalId === first}
                      pageNow={tick}
                      {...(blocked === undefined ? {} : { blocked })}
                      origin={{
                        ...originOf(card.approval),
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
                </PinnedDock>
              )}
              {chosen?.from === undefined ? null : (
                <ContinueBanner
                  title={titleOf(chosen.from)}
                  label={modelOf(chosen.model)?.label ?? chosen.model.id}
                  window={modelOf(chosen.model)?.window}
                  keepLast={chosen.keepLast}
                  onKeepLast={(n) =>
                    setNext({
                      model: chosen.model,
                      from: chosen.from as string,
                      ...(n === undefined ? {} : { keepLast: n }),
                    })
                  }
                  onCancel={() => open(chosen.from)}
                />
              )}
              <Composer
                focus={started}
                blocked={composerBlocked(state)}
                busy={sendBusy(state)}
                canAbort={running && state.connection === "open"}
                error={state.error}
                skills={state.status?.skills}
                onSend={(text) => {
                  const options = {
                    ...chosen,
                    ...(sendEffort === undefined ? {} : { effort: sendEffort }),
                  };
                  socket.submit(
                    text,
                    state.conv,
                    Object.keys(options).length === 0 ? undefined : options,
                  );
                }}
                onCommand={(name) => (name === "new" ? open(undefined) : setSheet(true))}
                {...(models === undefined
                  ? {}
                  : {
                      setup: (
                        <RunSetup
                          compact={phone}
                          model={{
                            label: nextLabel,
                            models,
                            current: targetRef,
                            spend,
                            note:
                              source === undefined
                                ? "這個對話還沒有訊息，可以直接換模型。送出第一則訊息後，模型就綁在對話上。"
                                : "模型綁在對話上。這個對話已有訊息，選另一個模型會開新對話接續。",
                            open: modelOpen,
                            ...(locked === undefined ? {} : { disabled: locked }),
                            onOpen: (o) => (phone ? o && pickModel() : setModelOpen(o)),
                            onChoose: (model) => {
                              setModelOpen(false);
                              if (
                                targetRef !== undefined &&
                                model.provider === targetRef.provider &&
                                model.id === targetRef.id
                              )
                                return;
                              if (source === undefined) return setNext({ model });
                              setForkPick(model);
                              setPicking("continue");
                            },
                          }}
                          effort={effort}
                          toast={toast !== 0}
                        />
                      ),
                    })}
                onAbort={() => {
                  if (state.conv !== undefined) socket.send("turn.abort", {}, state.conv);
                }}
              />
            </div>
          </footer>
        </div>
        {sheet ? <StatusSheet state={state} onClose={() => setSheet(false)} /> : null}
        {phone && effort !== undefined && effortOpen && levels.length > 0 ? (
          <EffortSheet effort={effort} modelLabel={target?.label ?? nextLabel} />
        ) : null}
        {picking === undefined ||
        models === undefined ||
        (picking === "continue" && sourceConv === undefined) ? null : (
          <ModelSheet
            models={models}
            picked={picking === "continue" ? (forkPick ?? chosen?.model) : chosen?.model}
            spend={spend}
            {...(picking === "continue" && source !== undefined && sourceConv !== undefined
              ? {
                  from: {
                    title: titleOf(source),
                    model: { provider: sourceConv.provider, id: sourceConv.model },
                  },
                }
              : {})}
            onClose={() => {
              setPicking(undefined);
              setForkPick(undefined);
            }}
            onConfirm={(model) => {
              setPicking(undefined);
              setForkPick(undefined);
              if (picking === "new") return setNext({ model });
              // The page goes to the new conversation; the first message there makes it.
              if (state.conv !== undefined) open(undefined);
              setNext({ model, from: source as string });
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Below 1024px the sidebar is a drawer. */
const COMPACT = "(max-width: 1023px)";
/** Below 768px the model and effort menus are sheets, as the prototype's isCompactViewport. */
const PHONE = "(max-width: 767px)";

/** Whether `query` matches now. jsdom has no matchMedia: there it is a desktop. */
function useMedia(query: string): boolean {
  const media = () =>
    typeof window.matchMedia === "function" ? window.matchMedia(query) : undefined;
  const [matches, setMatches] = useState(() => media()?.matches === true);
  // The queries are constants: one listener for the page's life.
  useEffect(() => {
    const list = media();
    if (list === undefined) return;
    const change = () => setMatches(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return matches;
}
