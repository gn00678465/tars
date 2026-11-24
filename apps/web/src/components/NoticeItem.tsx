import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "./ui/item.tsx";

/**
 * A notice, an error or a hint in the thread (ui_spec 5.6): shadcn's Item, outline, drawn as the
 * prototype's task-notice by its classes (app.css). The title with its mark, what it means, what
 * goes under it (a command to copy), and one action.
 */
export function NoticeItem(props: {
  tone: string;
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status";
}) {
  return (
    <Item
      className={`task-notice ${props.tone}`}
      {...(props.role === undefined ? {} : { role: props.role })}
    >
      <ItemContent className="task-notice-body">
        <ItemTitle className="task-notice-title">
          <Icon name="alert" />
          {props.title}
        </ItemTitle>
        {props.desc === undefined ? null : (
          <ItemDescription className="task-notice-desc">{props.desc}</ItemDescription>
        )}
        {props.children}
      </ItemContent>
      {props.action === undefined ? null : <ItemActions>{props.action}</ItemActions>}
    </Item>
  );
}
