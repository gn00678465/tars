// @vitest-environment jsdom
import type { WireModel } from "@tars/protocol";
import { act, createRef, useRef, useState } from "react";
import { afterEach, expect, test } from "vite-plus/test";
import { button, render } from "../render.ts";
import { frame, press } from "../testing.ts";
import { ModelSheet } from "./ModelSheet.tsx";
import { Panel } from "./Panel.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

const key = async (k: string) => {
  await act(
    async () =>
      void document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      ),
  );
  await frame();
};

/** A button that opens a Panel, as the app's are: the Panel mounted while open. */
function Opener(props: { phone: boolean; anchored: boolean }) {
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={at} onClick={() => setOpen(true)}>
        打開
      </button>
      <span>頁面</span>
      {open ? (
        <Panel
          phone={props.phone}
          {...(props.anchored ? { at: { ref: at, side: "top" as const } } : {})}
          title="標題"
          titleId="panel-title"
          onClose={() => setOpen(false)}
          foot={<span>腳</span>}
        >
          <input aria-label="欄位" />
        </Panel>
      ) : null}
    </>
  );
}

const popup = () => document.querySelector('[role="dialog"]');

test("a phone gets a bottom Drawer; wider, a Popover at its button, or a Dialog with none", async () => {
  const kind = async (phone: boolean, anchored: boolean) => {
    const { root, unmount } = await render(<Opener phone={phone} anchored={anchored} />);
    await act(async () => button(root, "打開").click());
    await frame();
    const seen = [popup()?.getAttribute("data-slot"), popup()?.getAttribute("aria-labelledby")];
    unmount();
    return seen;
  };
  expect(await kind(true, true)).toEqual(["drawer-popup", "panel-title"]);
  expect(await kind(false, true)).toEqual(["popover-content", "panel-title"]);
  expect(await kind(false, false)).toEqual(["dialog-content", "panel-title"]);
});

test.each([
  ["Drawer", true, true],
  ["Popover", false, true],
  ["Dialog", false, false],
])(
  "%s: the focus goes in, Esc closes it and the button has the focus back",
  async (_, phone, anchored) => {
    const { root } = await render(<Opener phone={phone} anchored={anchored} />);
    const open = button(root, "打開");
    open.focus();
    await act(async () => open.click());
    await frame();
    expect(popup()?.contains(document.activeElement)).toBe(true);
    await key("Escape");
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(open);
  },
);

test.each([
  ["Drawer", true, true],
  ["Popover", false, true],
  ["Dialog", false, false],
])("%s: a press outside closes it", async (_, phone, anchored) => {
  const { root } = await render(<Opener phone={phone} anchored={anchored} />);
  await act(async () => button(root, "打開").click());
  await frame();
  expect(popup()).not.toBeNull();
  // What lies outside the popup: its backdrop where it has one, else the page.
  const outside =
    document.querySelector('[data-slot$="overlay"]') ??
    ([...root.querySelectorAll("span")].find((s) => s.textContent === "頁面") as Element);
  await press(outside);
  await frame();
  expect(popup()).toBeNull();
});

const MODELS: WireModel[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    window: 200_000,
    isDefault: true,
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    provider: "openai",
    id: "gpt-6",
    label: "GPT-6",
    window: 400_000,
    isDefault: false,
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

test.each([
  ["a phone's Drawer", true],
  ["a Dialog", false],
])("ModelSheet in %s: the default chosen first, another picked and confirmed", async (_, phone) => {
  const confirmed: unknown[] = [];
  await render(
    <ModelSheet
      models={MODELS}
      picked={undefined}
      phone={phone}
      onConfirm={(m) => confirmed.push(m)}
      onClose={() => undefined}
    />,
  );
  await frame();
  const option = (label: string) =>
    [...document.querySelectorAll(".model-option")].find((o) =>
      o.textContent?.startsWith(label),
    ) as HTMLButtonElement;
  expect(option("Claude Sonnet 5.5").getAttribute("aria-pressed")).toBe("true");
  await act(async () => option("GPT-6").click());
  expect(option("GPT-6").getAttribute("aria-pressed")).toBe("true");
  expect(option("Claude Sonnet 5.5").getAttribute("aria-pressed")).toBe("false");
  await act(async () => button(document.body, "使用這個模型").click());
  expect(confirmed).toEqual([{ provider: "openai", id: "gpt-6" }]);
});

test("an anchor not in the page gets the centred Dialog, not a Popover at the corner", async () => {
  await render(
    <Panel
      phone={false}
      at={{ ref: createRef<HTMLElement>(), side: "top" }}
      title="標題"
      titleId="panel-title"
      onClose={() => undefined}
      foot={null}
    >
      內容
    </Panel>,
  );
  await frame();
  expect(popup()?.getAttribute("data-slot")).toBe("dialog-content");
});
