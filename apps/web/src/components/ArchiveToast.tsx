import { Icon } from "./Icon.tsx";

/**
 * The note after archiving: 已封存 with 復原 for a few seconds, or a sentence when it did not
 * work. Over the whole page (the drawer included), so it can be pressed from the list.
 */
export function ArchiveToast(props: {
  note: { readonly undo: boolean; readonly conv?: string; readonly text?: string };
  onUndo: () => void;
  onClose: () => void;
}) {
  return (
    <div className="archive-toast sg-popover" role="status" aria-live="polite">
      {props.note.undo ? (
        <>
          <span>已封存</span>
          <span className="archive-toast-dot" aria-hidden="true">
            ·
          </span>
          <button className="archive-toast-undo" type="button" onClick={props.onUndo}>
            復原
          </button>
        </>
      ) : (
        <>
          <span className="archive-toast-text">{props.note.text}</span>
          <button
            className="sg-icon-btn"
            type="button"
            aria-label="關閉"
            title="關閉"
            onClick={props.onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </>
      )}
    </div>
  );
}
