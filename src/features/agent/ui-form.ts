import { TOOL_TEXT_BYTES, type UiContext, UI_EVENT, uiFormProblem } from "@tars/protocol";
import { isRecord } from "../script/metadata.ts";
import { utf8Bytes } from "./bytes.ts";
import type { ToolOutcome } from "./tools.ts";

export const UI_SHOW_DONE =
  "已顯示表單。擁有者送出後，你會收到〔表單送出〕開頭的訊息。這一輪先結束，不要猜擁有者會填什麼。";

const refused = (why: string): ToolOutcome => ({
  status: "failed",
  text: `表單沒有顯示：${why}。改好再呼叫 ui_show。`,
  truncated: false,
});

/**
 * ui_show's checks before the page draws the form. The page validates the A2UI structure; this
 * checks what the local end trusts later: where it shows, that it reaches the page whole (the
 * tool_call input is cut at TOOL_TEXT_BYTES), and the components and the one action, with the
 * protocol's own uiFormProblem so both ends hold the same list.
 */
export function uiShow(input: unknown, via: "tty" | "remote"): ToolOutcome {
  if (via !== "remote") return refused("這個入口不能顯示表單，改用文字問");
  const bytes = utf8Bytes(JSON.stringify(input) ?? "");
  if (bytes > TOOL_TEXT_BYTES) return refused(`輸入有 ${bytes} 位元組，超過 ${TOOL_TEXT_BYTES}`);
  if (
    !isRecord(input) ||
    !Array.isArray(input.components) ||
    !isRecord(input.dataModel) ||
    Object.keys(input).length !== 2
  )
    return refused("輸入只能有 components（陣列）與 dataModel（物件）");
  const problem = uiFormProblem(input.components);
  return problem === undefined
    ? { status: "done", text: UI_SHOW_DONE, truncated: false }
    : refused(problem);
}

const FIELDS = ["date", "amount", "target", "source", "narration", "payee"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,4})?$/;
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The owner's message for a sent form, or why its values are refused. The accounts must be among
 * the options of the stored form's pickers, not what the browser lists; the values become a
 * script's arguments later, so none starts with "-" or holds a control character.
 */
export function formMessage(
  form: unknown,
  context: UiContext,
): { ok: true; text: string } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  const components = isRecord(form) && Array.isArray(form.components) ? form.components : [];
  const button = components.find((c) => isRecord(c) && c.component === "Button");
  const event = isRecord(button) && isRecord(button.action) ? button.action.event : undefined;
  if (!isRecord(event) || event.name !== UI_EVENT) return bad(`the form is not ${UI_EVENT}`);
  for (const key of Object.keys(context))
    if (!(FIELDS as readonly string[]).includes(key)) return bad(`unknown field ${key}`);
  const values: Record<string, string> = {};
  for (const key of FIELDS) {
    // A picker sends a list of one; a text field a string, absent when left unset.
    const raw = context[key] ?? (key === "source" || key === "target" ? undefined : "");
    const v = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
    if (v === undefined || Array.isArray(raw) !== (key === "source" || key === "target"))
      return bad(`${key} is not one value`);
    if (CONTROL.test(v) || v.startsWith("-")) return bad(`${key} has a control character or a -`);
    values[key] = v;
  }
  const { date, amount, target, source, narration, payee } = values as Record<
    (typeof FIELDS)[number],
    string
  >;
  if (!DATE.test(date) || !realDate(date)) return bad("date is not a YYYY-MM-DD day");
  if (!AMOUNT.test(amount) || Number(amount) <= 0) return bad("amount is not a positive decimal");
  for (const [key, v] of [
    ["target", target],
    ["source", source],
  ] as const)
    if (!options(components, event.context, key).includes(v)) return bad(`${key} is not offered`);
  if (source === target) return bad("source and target are the same account");
  const chars = (s: string) => [...s].length;
  if (chars(narration) < 1 || chars(narration) > 200) return bad("narration is not 1-200 chars");
  if (chars(payee) > 100) return bad("payee is over 100 chars");
  return {
    ok: true,
    text: [
      "〔表單送出〕記帳",
      `日期：${date}`,
      `金額：${amount}`,
      `借方帳戶：${target}`,
      `貸方帳戶：${source}`,
      `摘要：${narration}`,
      `付款對象：${payee === "" ? "（空）" : payee}`,
    ].join("\n"),
  };
}

function realDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** The values a picker offers: the one bound to the path the button sends as `key`. */
function options(components: readonly unknown[], context: unknown, key: string): string[] {
  const bound = isRecord(context) && isRecord(context[key]) ? context[key]["@path"] : undefined;
  if (typeof bound !== "string") return [];
  const picker = components.find(
    (c) =>
      isRecord(c) &&
      c.component === "ChoicePicker" &&
      isRecord(c.value) &&
      c.value["@path"] === bound,
  );
  const list = isRecord(picker) && Array.isArray(picker.options) ? picker.options : [];
  return list.flatMap((o) => (isRecord(o) && typeof o.value === "string" ? [o.value] : []));
}
