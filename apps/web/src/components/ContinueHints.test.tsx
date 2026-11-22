// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import type { WireModel, WireStatus } from "@tars/protocol";
import { act } from "react";
import { render } from "../render.ts";
import { ContinueHints } from "./ContinueHints.tsx";

const MODELS: WireModel[] = [
  { provider: "anthropic", id: "a", label: "A", isDefault: true },
  { provider: "anthropic", id: "b", label: "B", isDefault: false, unusable: "no_key" },
];
const provider = (name: string, spentUsd: number, stopped = false) => ({
  name,
  spentUsd,
  quotaUsd: 100,
  warnUsd: 80,
  stopUsd: 95,
  stopped,
});
const STATUS = {
  providers: [provider("anthropic", 95.1), provider("gemini", 3), provider("openrouter", 1)],
} as unknown as WireStatus;

const shown = async (
  conv: { provider: string; model: string },
  status: WireStatus | undefined,
  models = MODELS,
) => {
  let continued = 0;
  const r = await render(
    <ContinueHints
      conv={conv}
      models={models}
      status={status}
      onContinue={() => (continued += 1)}
    />,
  );
  const notices = [...r.root.querySelectorAll(".task-notice")].map((n) => ({
    tone: n.className,
    title: n.querySelector(".task-notice-title")?.textContent,
    desc: n.querySelector(".task-notice-desc")?.textContent,
    action: n.querySelector("button")?.textContent,
  }));
  const click = () => act(async () => r.root.querySelector("button")?.click());
  return { notices, click, continued: () => continued, unmount: r.unmount };
};

describe("ContinueHints", () => {
  test("a usable model on a provider within budget: nothing", async () => {
    const s = await shown({ provider: "anthropic", model: "a" }, undefined);
    expect(s.notices).toEqual([]);
    s.unmount();
  });

  test("a model no longer listed is retired; one listed as unusable says why", async () => {
    const gone = await shown({ provider: "anthropic", model: "old" }, undefined);
    expect(gone.notices).toEqual([
      {
        tone: "task-notice warn",
        title: "這個模型已停用，請以另一個模型接續",
        desc: "本機端的模型清單已沒有 old。",
        action: "選擇接續模型",
      },
    ]);
    await gone.click();
    expect(gone.continued()).toBe(1);
    gone.unmount();
    const key = await shown({ provider: "anthropic", model: "b" }, undefined);
    expect(key.notices[0]?.title).toBe("這個模型目前無法使用，請以另一個模型接續");
    expect(key.notices[0]?.desc).toContain("沒有 API 金鑰");
    key.unmount();
    // An empty list says nothing about this model.
    const empty = await shown({ provider: "anthropic", model: "old" }, undefined, []);
    expect(empty.notices).toEqual([]);
    empty.unmount();
  });

  test("a provider past its stop threshold names the ones still open", async () => {
    const s = await shown({ provider: "anthropic", model: "a" }, STATUS);
    expect(s.notices).toEqual([
      {
        tone: "task-notice error",
        title: "Anthropic 已達本期上限，可以改用其他 provider 接續",
        desc: "本期已用 95.10 / 100 USD（估），Gemini 與 OpenRouter 仍可正常使用。",
        action: "改用其他模型",
      },
    ]);
    s.unmount();
  });
});
