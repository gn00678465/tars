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

/** Why the components may not be drawn, or undefined when they may. */
export function uiFormProblem(components: readonly unknown[]): string | undefined {
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
  return deepProblem(components);
}

function deepProblem(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = deepProblem(x);
      if (p !== undefined) return p;
    }
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  for (const [k, x] of Object.entries(v)) {
    if (k === "functionCall") return "a functionCall action";
    if (k === "@call" && (typeof x !== "string" || !UI_CALLS.includes(x)))
      return `call ${String(x)} is not allowed`;
    const p = deepProblem(x);
    if (p !== undefined) return p;
  }
  return undefined;
}
