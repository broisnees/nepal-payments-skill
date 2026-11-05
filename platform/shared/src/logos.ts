// Official gateway logos, served at /logos by the dashboard build (sources: website/public/logos/README.md).
// `dark` is the gateway's own version for dark backgrounds; `chip` logos sit on a light chip in dark mode.
// `ratio` is width / height; `scale` evens out optical size for tall or detailed marks.
export interface GatewayLogo {
  light: string;
  dark?: string;
  ratio: number;
  chip?: boolean;
  scale?: number;
}

export const GATEWAY_LOGOS: Record<string, GatewayLogo> = {
  esewa: { light: "/logos/esewa.svg", dark: "/logos/esewa-white.svg", ratio: 324.77 / 89.38 },
  khalti: { light: "/logos/khalti.svg", ratio: 366.28 / 150.29 },
  fonepay: { light: "/logos/fonepay.png", dark: "/logos/fonepay-white.png", ratio: 1008 / 308 },
  connectips: { light: "/logos/connectips.png", ratio: 100 / 65, chip: true, scale: 1.7 },
  cybersource: { light: "/logos/cybersource.png", ratio: 177 / 44, chip: true, scale: 1.2 },
  nps: { light: "/logos/nps.png", dark: "/logos/nps-white.png", ratio: 1200 / 527 },
  imepay: { light: "/logos/khalti-by-ime.png", ratio: 1028 / 569, chip: true, scale: 1.45 },
};
