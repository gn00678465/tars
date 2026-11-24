// The app's overlays (M4-P2) and how a scene opens each: csp.ts checks their keys, focus and
// backdrop, pull.ts that none lets a pull reload the page.
import { SCENES } from "./scenes.ts";

export const WIDTHS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

/** A scene's number by its name's start. */
export const sceneOf = (name: string) => {
  const n = SCENES.findIndex((s) => s.name.startsWith(name)) + 1;
  if (n === 0) throw new Error(`no scene ${name} in scenes.ts`);
  return n;
};
export const drawer = '[aria-label="展開對話列表"]';
export const conv = (title: string) => `.conv-list >> text=${title}`;
export interface Overlay {
  name: string;
  scene: number;
  /** Clicks before the button, at each width. */
  before: Record<keyof typeof WIDTHS, string[]>;
  button: Partial<Record<keyof typeof WIDTHS, string>>;
  /** The popup's data-slot at each width; left out, the overlay is not there at that width. */
  slot: Partial<Record<keyof typeof WIDTHS, string>>;
  /** A menu: Tab leaves it and closes it, as the WAI-ARIA menu pattern has it. */
  menu?: boolean;
  /** On a phone, opened from another overlay, which closes: no button to give the focus back to. */
  from?: string;
}
export const STATUS_PHONE = '[aria-label="開啟系統狀態與花費面板"]';
/** A phone opens the context sheet from the status sheet; the thread's hint has one too. */
const STATUS_COMPACT = '.sheet-foot button:has-text("開啟壓縮")';
export const OVERLAYS: Overlay[] = [
  {
    name: "status sheet",
    scene: sceneOf("花費"),
    before: { desktop: [], phone: [] },
    button: {
      desktop: "header .sg-btn.desktop-only",
      phone: STATUS_PHONE,
    },
    slot: { desktop: "dialog-content", phone: "drawer-popup" },
  },
  {
    name: "context sheet",
    scene: sceneOf("壓縮"),
    before: {
      desktop: [conv("SQLite FTS5 的中文斷詞")],
      phone: [drawer, conv("SQLite FTS5 的中文斷詞")],
    },
    button: { desktop: '[aria-label="上下文用量與壓縮"]', phone: STATUS_COMPACT },
    slot: { desktop: "popover-content", phone: "drawer-popup" },
    from: STATUS_PHONE,
  },
  {
    name: "model menu and sheet",
    scene: sceneOf("新對話與模型選單"),
    before: { desktop: ['button:has-text("新對話")'], phone: [] },
    button: { desktop: '.run-seg:has-text("模型")', phone: '.run-seg:has-text("模型")' },
    slot: { desktop: "dropdown-menu-content", phone: "drawer-popup" },
    menu: true,
  },
  {
    name: "effort menu and sheet",
    scene: sceneOf("推理強度選單"),
    before: { desktop: [conv("整理 NAS 備份腳本")], phone: [drawer, conv("整理 NAS 備份腳本")] },
    button: { desktop: '.run-seg:has-text("推理")', phone: '.run-seg:has-text("推理")' },
    slot: { desktop: "dropdown-menu-content", phone: "drawer-popup" },
    menu: true,
  },
  {
    name: "model sheet to continue",
    scene: sceneOf("以另一個模型接續的提示"),
    before: { desktop: [conv("上個月的帳單")], phone: [drawer, conv("上個月的帳單")] },
    button: {
      desktop: 'button:has-text("以另一個模型接續")',
      phone: 'button:has-text("以另一個模型接續")',
    },
    slot: { desktop: "popover-content", phone: "drawer-popup" },
  },
  {
    name: "conversation drawer",
    scene: sceneOf("對話列表"),
    before: { desktop: [], phone: [] },
    button: { phone: drawer },
    slot: { phone: "sheet-content" },
  },
  {
    name: "wiki source",
    scene: sceneOf("知識庫的一頁"),
    before: {
      desktop: ['button:has-text("個人知識庫")'],
      phone: ['button:has-text("個人知識庫")'],
    },
    button: { desktop: ".wiki-cite-pill", phone: ".wiki-cite-pill" },
    slot: { desktop: "dialog-content", phone: "drawer-popup" },
  },
];
