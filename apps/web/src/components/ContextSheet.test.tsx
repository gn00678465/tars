// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { button, render, unmountAll } from "../render.ts";
import { ContextRing, ContextSheet } from "./ContextSheet.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const context = {
  contextUsed: 48_200,
  contextLimit: 200_000,
  warnRatio: 0.6,
  compactRatio: 0.75,
  stopRatio: 0.85,
  autoCompact: false,
};

test("E1: the ring turns at the local end's warn and stop lines", async () => {
  const tone = async (used: number) => {
    unmountAll();
    const { root } = await render(
      <ContextRing
        context={{ ...context, contextUsed: used }}
        onOpen={() => undefined}
        open={false}
      />,
    );
    return root.querySelector(".context-ring-fill")?.getAttribute("class");
  };
  expect(await tone(119_000)).toBe("context-ring-fill ");
  expect(await tone(120_000)).toBe("context-ring-fill warn");
  expect(await tone(170_000)).toBe("context-ring-fill error");
});

test("E2, E3: no cache figure or compaction yet, auto off; a blocked or too long request cannot go", async () => {
  const asked: (string | undefined)[] = [];
  const sheet = (blocked: string | undefined, focus?: string) =>
    render(
      <ContextSheet
        context={context}
        conv="0123456789abcdef"
        blocked={blocked}
        {...(focus === undefined ? {} : { focus })}
        onCompact={(f) => asked.push(f)}
        onClose={() => undefined}
        phone={false}
      />,
    );
  // The sheet is a popup under document.body, not in the element it was rendered into.
  await sheet(undefined);
  const root = document.body;
  expect([...root.querySelectorAll("dd")].map((d) => d.textContent)).toEqual([
    "48,200 / 200,000 tokens（24%）",
    "還沒有回合",
    "還沒有壓縮過",
    "自動壓縮關閉 · 85% 硬停",
    "89abcdef",
  ]);
  await act(async () => button(root, "立即壓縮").click());
  expect(asked).toEqual([undefined]);
  unmountAll();
  await sheet("回合進行中");
  expect(button(document.body, "立即壓縮").disabled).toBe(true);
  expect(document.body.querySelector(".composer-disabled-reason")?.textContent).toBe("回合進行中");
  unmountAll();
  await sheet(undefined, "字".repeat(501));
  expect(button(document.body, "立即壓縮").disabled).toBe(true);
  expect(document.body.querySelector(".composer-disabled-reason")?.textContent).toBe(
    "要保留的說明最多 500 字，目前 501 字",
  );
});

test("the bar says the share used, at the ring's tone, and caps at 100", async () => {
  const bar = async (used: number) => {
    unmountAll();
    await render(
      <ContextSheet
        context={{ ...context, contextUsed: used }}
        conv="0123456789abcdef"
        blocked={undefined}
        onCompact={() => undefined}
        onClose={() => undefined}
        phone={false}
      />,
    );
    const p = document.body.querySelector('[role="progressbar"]') as HTMLElement;
    return [
      p.getAttribute("aria-label"),
      p.getAttribute("aria-valuenow"),
      p.getAttribute("aria-valuetext"),
      p.closest(".context-progress.warn") !== null,
      p.closest(".context-progress.error") !== null,
    ];
  };
  expect(await bar(48_200)).toEqual(["上下文使用量", "24", "24%", false, false]);
  expect(await bar(150_000)).toEqual(["上下文使用量", "75", "75%", true, false]);
  expect(await bar(260_000)).toEqual(["上下文使用量", "100", "100%", false, true]);
});
