import {
  Archive,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  GitFork,
  Layers,
  type LucideIcon,
  Menu,
  PanelLeft,
  Plus,
  Shield,
  Terminal,
  X,
} from "lucide-react";

/**
 * The prototype's icons (M3/prototype/app.js iconSvg) as lucide's of the same shape, named by
 * import so the rest of lucide is not in the bundle.
 */
const ICONS = {
  chevron: ChevronDown,
  check: Check,
  copy: Copy,
  shield: Shield,
  terminal: Terminal,
  alert: CircleAlert,
  archive: Archive,
  close: X,
  fork: GitFork,
  plus: Plus,
  menu: Menu,
  sidebar: PanelLeft,
  layers: Layers,
} as const satisfies Record<string, LucideIcon>;

export function Icon({ name, size = 14 }: { name: keyof typeof ICONS; size?: number }) {
  const Drawn = ICONS[name];
  // The prototype's stroke, not lucide's 2.
  return <Drawn size={size} strokeWidth={1.7} aria-hidden="true" />;
}

/** The brand mark: the first frame of the idle sprite, still (app.css `.tars-mark`). */
export function BrandMark() {
  return <span className="tars-mark" aria-hidden="true" />;
}
