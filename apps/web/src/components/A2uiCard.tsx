/**
 * The A2UI half of a ui_show form, loaded with import() the first time a form is drawn: A2UI and
 * the zod 3 it brings stay in this chunk (m4_design_a2ui.md 1.5, 6.2). Nothing here or in what it
 * imports may import zod or @tars/protocol, which would pull zod 4 in and mix the two.
 *
 * Key names are the installed 0.15.0's, not the website's: bindings are @path and @call, a
 * component's checks has no @ (research/a2ui_proto_result.md). Markdown is not wired, so Text is
 * plain text.
 */
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react";
import {
  type ActionPayload,
  basicCatalog,
  injectBasicCatalogStyles,
  MessageProcessor,
  STRICT_VALIDATION,
  type SurfaceModel,
} from "@a2ui/web_core/v1_0";
import { type ReactNode, useEffect, useMemo, useRef } from "react";

/** ui_show's input: the model writes components and data, the page the envelope. */
export interface FormSpec {
  readonly components: readonly unknown[];
  readonly dataModel?: Record<string, unknown>;
}

export type Built =
  | { readonly ok: true; readonly surface: SurfaceModel<ReactCatalogComponent> }
  | { readonly ok: false; readonly problem: string };

/**
 * One processor per form, strictly validated: A2UI leaves validation off unless asked. The
 * surface is named by the call, so forms never share one. A form that does not validate is not
 * drawn at all, rather than drawn in part.
 */
export function buildSurface(
  callId: string,
  spec: FormSpec,
  onAction: (action: ActionPayload) => void,
): Built {
  const processor = new MessageProcessor<ReactCatalogComponent>([basicCatalog as never], onAction, {
    validationConfig: { ...STRICT_VALIDATION, targetVersion: "1.0" },
  });
  try {
    processor.processMessages({
      version: "1.0",
      createSurface: {
        surfaceId: callId,
        catalogId: basicCatalog.id,
        components: spec.components,
        ...(spec.dataModel === undefined ? {} : { dataModel: spec.dataModel }),
      },
    } as never);
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
  const surface = processor.getSurfaces().get(callId);
  return surface === undefined ? { ok: false, problem: "no surface" } : { ok: true, surface };
}

let styled = false;

export default function A2uiCard({
  callId,
  spec,
  onAction,
  frame,
  invalid,
}: {
  callId: string;
  spec: FormSpec;
  /** The button's action, resolved: its context holds the fields' values. */
  onAction: (action: ActionPayload) => void;
  /** The page's frame around the drawn form. */
  frame: (form: ReactNode) => ReactNode;
  /** What is drawn instead when the form does not validate: no frame, as nothing is a form. */
  invalid: ReactNode;
}) {
  if (!styled) {
    // The basic catalog's tokens and rules, adopted once by the document (no inline style).
    injectBasicCatalogStyles();
    styled = true;
  }
  // A form is written once (ui_show's input never changes), so it is built once per call; the
  // handler goes through a ref so a new onAction does not build it again.
  const handler = useRef(onAction);
  useEffect(() => {
    handler.current = onAction;
  }, [onAction]);
  const built = useMemo(
    () => buildSurface(callId, spec, (a) => handler.current(a)),
    [callId, spec],
  );
  if (!built.ok) return invalid;
  return frame(<A2uiSurface surface={built.surface} />);
}
