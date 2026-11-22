import { useEffect, useReducer, useRef, useState } from "react";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { ConversationList } from "./components/ConversationList.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
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

  // A conversation opened from the list: the page goes to its thread, which may sit below.
  const thread = useRef<HTMLElement>(null);
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    if (opened > 0) thread.current?.focus();
  }, [opened]);

  const open = (c: string | undefined) => {
    dispatch({ type: "open_conv", conv: c });
    if (c === undefined) return;
    socket.send("conv.open", {}, c);
    setOpened((n) => n + 1);
  };
  const oldest = state.items[0]?.seq;
  const running = state.turn?.state === "started" && state.conv !== undefined;
  const pending = state.cards.filter((c) => c.resolved === undefined);
  const settled = state.cards.filter((c) => c.resolved !== undefined).slice(-3);

  return (
    <main>
      <StatusBar state={state} />
      {[...pending, ...settled].map((card) => (
        <ApprovalCard
          key={card.approval.approvalId}
          card={card}
          localNow={localNow(state, tick)}
          onDecide={(decision) => {
            const id = socket.send("approval.decide", {
              approvalId: card.approval.approvalId,
              decision,
              hash: card.approval.hash,
            });
            if (id !== undefined)
              dispatch({ type: "deciding", approvalId: card.approval.approvalId, id });
          }}
        />
      ))}
      <ConversationList convs={state.convs} current={state.conv} onOpen={open} />
      <Thread
        ref={thread}
        state={state}
        onOlder={() => {
          if (state.conv !== undefined && oldest !== undefined)
            socket.send("conv.open", { before: oldest }, state.conv);
        }}
      />
      <Composer
        blocked={composerBlocked(state)}
        canAbort={running && state.connection === "open"}
        error={state.error}
        onSend={(text) => socket.submit(text, state.conv)}
        onAbort={() => {
          if (state.conv !== undefined) socket.send("turn.abort", {}, state.conv);
        }}
      />
    </main>
  );
}
