// Hugeicons (free stroke set) rendered to SVG markup at build time, so pages ship no icon runtime.
import {
  Activity01Icon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  BotIcon,
  CommandLineIcon,
  ComputerIcon,
  Copy01Icon,
  File01Icon,
  FileScriptIcon,
  Folder01Icon,
  GithubIcon,
  LaptopIcon,
  LifebuoyIcon,
  LockIcon,
  MinusSignIcon,
  Moon02Icon,
  PaintBoardIcon,
  Search01Icon,
  SecurityCheckIcon,
  Settings02Icon,
  SparklesIcon,
  Sun03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

type IconData = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

export const ICONS = {
  activity: Activity01Icon,
  copy: Copy01Icon,
  check: Tick02Icon,
  chevron: ArrowRight01Icon,
  down: ArrowDown01Icon,
  updown: ArrowUpDownIcon,
  external: ArrowUpRight01Icon,
  plus: Add01Icon,
  minus: MinusSignIcon,
  github: GithubIcon,
  file: File01Icon,
  markdown: FileScriptIcon,
  folder: Folder01Icon,
  terminal: CommandLineIcon,
  shield: SecurityCheckIcon,
  search: Search01Icon,
  lock: LockIcon,
  settings: Settings02Icon,
  palette: PaintBoardIcon,
  sun: Sun03Icon,
  moon: Moon02Icon,
  monitor: ComputerIcon,
  laptop: LaptopIcon,
  sparkles: SparklesIcon,
  bot: BotIcon,
  lifebuoy: LifebuoyIcon,
} as const;

export type IconName = keyof typeof ICONS;

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The icon's inner SVG elements, ready for set:html or a template string. */
export function iconInner(name: IconName): string {
  return (ICONS[name] as unknown as IconData)
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${kebab(k)}="${String(v)}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
}

/** A complete inline SVG. */
export function iconSvg(name: IconName, size = 16, cls = ""): string {
  return `<svg${cls ? ` class="${cls}"` : ""} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${iconInner(name)}</svg>`;
}
