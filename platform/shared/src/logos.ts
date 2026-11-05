// Official gateway logos, served at /logos by the dashboard build (sources: website/public/logos/README.md).
// `dark` is the gateway's own version for dark backgrounds; `chip` logos sit on a light chip in dark mode.
// `ratio` is width / height; `scale` evens out optical size for tall or detailed marks.
export interface GatewayLogo {
  /** Square app-style mark for compact places (lists, tables); shown on a light tile. */
  icon: string;
  light: string;
  dark?: string;
  ratio: number;
  chip?: boolean;
  scale?: number;
}

export const GATEWAY_LOGOS: Record<string, GatewayLogo> = {
  esewa: { icon: "/logos/icons/esewa.svg", light: "/logos/esewa.svg", dark: "/logos/esewa-white.svg", ratio: 324.77 / 89.38 },
  khalti: { icon: "/logos/icons/khalti.png", light: "/logos/khalti.svg", ratio: 366.28 / 150.29 },
  fonepay: { icon: "/logos/icons/fonepay.png", light: "/logos/fonepay.png", dark: "/logos/fonepay-white.png", ratio: 1008 / 308 },
  connectips: { icon: "/logos/icons/connectips.png", light: "/logos/connectips.png", ratio: 100 / 65, chip: true, scale: 1.7 },
  cybersource: { icon: "/logos/icons/cybersource.png", light: "/logos/cybersource.png", ratio: 177 / 44, chip: true, scale: 1.2 },
  nps: { icon: "/logos/icons/nps.png", light: "/logos/nps.png", dark: "/logos/nps-white.png", ratio: 1200 / 527 },
  imepay: { icon: "/logos/icons/imepay.png", light: "/logos/khalti-by-ime.png", ratio: 1028 / 569, chip: true, scale: 1.45 },
};
