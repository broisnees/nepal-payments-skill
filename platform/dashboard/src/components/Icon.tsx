// Outline icons on a 24 grid, 1.5 stroke to sit beside 400-450 weight text. One SVG, colored by currentColor.
const P: Record<string, string> = {
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4-4",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  chevronLeft: "m15 6-6 6 6 6",
  chevronsUpDown: "m7 15 5 5 5-5M7 9l5-5 5 5",
  arrowLeft: "M19 12H5m6-6-6 6 6 6",
  arrowUpRight: "M7 17 17 7M8 7h9v9",
  check: "m5 12.5 4.5 4.5L19 7.5",
  copy: "M9 9h10v10H9zM5 15V5h10",
  x: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-14v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z",
  monitor: "M3 4h18v12H3zM8 20h8m-4-4v4",
  pause: "M8 5v14m8-14v14",
  play: "M7 4.5v15l12-7.5-12-7.5Z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4a2 2 0 0 0 4 0",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-1.6.1-1.4-.1-1.4 2-1.6-2-3.4-2.4.9a7.6 7.6 0 0 0-2.4-1.4L14 2h-4l-.6 2.6A7.6 7.6 0 0 0 7 6l-2.4-.9-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4L7 18a7.6 7.6 0 0 0 2.4 1.4L10 22h4l.6-2.6A7.6 7.6 0 0 0 17 18l2.4.9 2-3.4-2-1.6Z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  alert: "M12 9v4m0 4h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-6v-4m0-4h.01",
  external: "M14 4h6v6m0-6-9 9m-1-7H4v14h14v-6",
  key: "M15.5 7.5a2 2 0 1 1 0 .01M21 3l-9.6 9.6a5 5 0 1 1-1.4-1.4L19.6 1.6M17 7l2 2",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  terminal: "m4 17 6-6-6-6m8 14h8",
  laptop: "M4 5h16v10H4zM2 19h20",
  phone: "M7 2h10v20H7zM11 18h2",
  mail: "M3 5h18v14H3zm0 0 9 7 9-7",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  webhook: "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8",
  message: "M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4",
  trash: "M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  logout: "M9 21H4V3h5m7 14 5-5-5-5m5 5H9",
  zap: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-15v5l3 2",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
  flask: "M9 3h6m-5 0v6L4.5 19A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-2L14 9V3M7 15h10",
  lock: "M5 11h14v10H5zm3 0V7a4 4 0 1 1 8 0v4",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2m20 0v7H2v-7m20 0L18.5 5h-13L2 12",
  filter: "M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className, strokeWidth = 1.5 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={P[name]} />
    </svg>
  );
}

/** The paynp mark from the marketing favicon, drawn in ink so it follows the theme. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" fill="var(--ink)" />
      <path d="M10.5 7.5 22.5 15h-7.4l7.4 9.5H10.5z" stroke="var(--on-ink)" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="14.4" cy="20.4" r="1.7" fill="#F43F5E" />
    </svg>
  );
}
