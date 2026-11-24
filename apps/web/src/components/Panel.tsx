import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ReactNode, RefObject } from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { Icon } from "./Icon.tsx";

/**
 * The prototype's sheet (a head with the title and a close button, a body, a foot) in shadcn's
 * overlays: a Drawer from the bottom on a phone; elsewhere a Popover at `at`, or a centred
 * Dialog when nothing anchors it. Base UI keeps the focus inside, closes on Esc and on a press
 * outside, and gives the focus back. Mounting it opens it; `onClose` asks the caller to unmount it.
 */
export function Panel(props: {
  phone: boolean;
  /** The element the desktop popover drops from, and the side of it: the top bar's drops below. */
  at?: { readonly ref: RefObject<HTMLElement | null>; readonly side: "top" | "bottom" };
  title: ReactNode;
  /** The title's id: the panel is labelled by it. */
  titleId: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
  foot: ReactNode;
}) {
  const look = props.wide === true ? "sheet-panel sg-popover wide" : "sheet-panel sg-popover";
  const change = (open: boolean) => {
    if (!open) props.onClose();
  };
  const close = <Icon name="close" size={15} />;
  const rest = (
    <>
      <div className="sheet-body">{props.children}</div>
      <div className="sheet-foot">{props.foot}</div>
    </>
  );
  if (props.phone)
    return (
      <Drawer open onOpenChange={change}>
        <DrawerContent className={look}>
          <div className="sheet-head">
            <DrawerTitle id={props.titleId}>{props.title}</DrawerTitle>
            <DrawerClose className="sg-icon-btn" aria-label="關閉">
              {close}
            </DrawerClose>
          </div>
          {rest}
        </DrawerContent>
      </Drawer>
    );
  // Mounted after its button: an anchor not in the page (none drawn) gets the centred Dialog.
  if (props.at?.ref.current?.isConnected === true)
    return (
      // Modal: the page behind takes no presses and the focus stays in, as the sheet did.
      <Popover open onOpenChange={change} modal>
        <PopoverContent
          className={look}
          anchor={props.at.ref}
          side={props.at.side}
          align="end"
          sideOffset={8}
        >
          <div className="sheet-head">
            <PopoverTitle id={props.titleId}>{props.title}</PopoverTitle>
            <PopoverPrimitive.Close className="sg-icon-btn" aria-label="關閉">
              {close}
            </PopoverPrimitive.Close>
          </div>
          {rest}
        </PopoverContent>
      </Popover>
    );
  return (
    <Dialog open onOpenChange={change}>
      <DialogContent className={look} showCloseButton={false}>
        <div className="sheet-head">
          <DialogTitle id={props.titleId}>{props.title}</DialogTitle>
          <DialogClose className="sg-icon-btn" aria-label="關閉">
            {close}
          </DialogClose>
        </div>
        {rest}
      </DialogContent>
    </Dialog>
  );
}
