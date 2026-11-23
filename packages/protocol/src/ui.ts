/**
 * What a ui_show form may hold. The model writes the form, and a prompt injection can steer the
 * model, so the page checks this before A2UI draws anything and the local end checks it again
 * (B2). The basic catalog registers more: Modal, Image, the openUrl action. openUrl runs wherever
 * a value calls it, not only as a button's action, so @call names are limited too.
 */
export const UI_COMPONENTS: readonly string[] = [
  "Column",
  "Row",
  "Text",
  "Divider",
  "TextField",
  "DateTimeInput",
  "ChoicePicker",
  // The page's own: a combobox of accounts (apps/web AccountSelect.tsx).
  "AccountSelect",
  "Button",
];

/** Functions a value or a check may call: validation only, no side effects. */
export const UI_CALLS: readonly string[] = [
  "required",
  "length",
  "numeric",
  "email",
  "and",
  "or",
  "not",
];

/** The one event a form's one button may send. */
export const UI_EVENT = "ledger_submit";

/**
 * How deep a form may nest (the components array is level 1) and how many values it may hold,
 * components and data together. The check recurses: without a bound, 16 KiB of short nested
 * arrays would overflow the stack. The ledger form nests 10 levels and holds about 150 values.
 */
export const UI_MAX_DEPTH = 16;
export const UI_MAX_NODES = 2_000;

/** Keys refused at any level, so nothing A2UI does with the form can reach a prototype. */
const UI_BAD_KEYS = ["__proto__", "constructor", "prototype"];

/** Why the form may not be drawn, or undefined when it may. */
export function uiFormProblem(
  components: readonly unknown[],
  dataModel?: unknown,
): string | undefined {
  const walk = { nodes: 0 };
  const shape = deepProblem(components, 1, walk) ?? deepProblem(dataModel, 1, walk, false);
  if (shape !== undefined) return shape;
  let buttons = 0;
  for (const c of components) {
    if (typeof c !== "object" || c === null) return "a component is not an object";
    const { component, action } = c as { component?: unknown; action?: unknown };
    if (typeof component !== "string" || !UI_COMPONENTS.includes(component))
      return `component ${String(component)} is not allowed`;
    if (component !== "Button") {
      if (action !== undefined) return `${component} has an action`;
      continue;
    }
    buttons++;
    const event = (action as { event?: { name?: unknown } } | undefined)?.event;
    if (event?.name !== UI_EVENT || Object.keys(action as object).length !== 1)
      return `the button's action is not the ${UI_EVENT} event`;
  }
  if (buttons !== 1) return `${buttons} buttons, not one`;
  return undefined;
}

/** Bounds, refused keys and (in components) actions and calls, at every level of v. */
function deepProblem(
  v: unknown,
  depth: number,
  walk: { nodes: number },
  components = true,
): string | undefined {
  if (++walk.nodes > UI_MAX_NODES) return `more than ${UI_MAX_NODES} values`;
  if (typeof v !== "object" || v === null) return undefined;
  if (depth > UI_MAX_DEPTH) return `nested deeper than ${UI_MAX_DEPTH}`;
  const entries = Array.isArray(v) ? v.map((x) => ["", x] as const) : Object.entries(v);
  for (const [k, x] of entries) {
    if (UI_BAD_KEYS.includes(k)) return `key ${k}`;
    if (components && k === "functionCall") return "a functionCall action";
    if (components && k === "@call" && (typeof x !== "string" || !UI_CALLS.includes(x)))
      return `call ${String(x)} is not allowed`;
    const p = deepProblem(x, depth + 1, walk, components);
    if (p !== undefined) return p;
  }
  return undefined;
}
