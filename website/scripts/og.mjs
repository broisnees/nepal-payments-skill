// Renders public/og.png (1200x630) for social cards. Re-run after changing the copy: node scripts/og.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
const providers = ["eSewa", "Khalti", "Fonepay", "connectIPS", "CyberSource", "NPS", "IME Pay"];
let x = 80;
const chips = providers
  .map((p) => {
    const w = p.length * 13.5 + 36;
    const chip = `<g transform="translate(${x},468)"><rect width="${w}" height="46" fill="#ffffff" stroke="#d6d6d6"/><text x="${w / 2}" y="30" text-anchor="middle" font-size="21" fill="#1f1f1f">${p}</text></g>`;
    x += w + 12;
    return chip;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter, 'Noto Sans', 'DejaVu Sans', sans-serif">
  <rect width="1200" height="630" fill="#ffffff"/>
  <rect x="0" y="0" width="1200" height="40" fill="#0a0a0a"/>
  <text x="600" y="26" text-anchor="middle" font-size="17" fill="#ffffff">Open source Agent Skill · MIT</text>
  <rect x="40.5" y="60.5" width="1119" height="529" fill="none" stroke="#e6e6e6"/>
  <g transform="translate(80,74) scale(1.9)"><path d="M7 3.5 25 14.2H13.6L25 28.5H7Z" fill="#DC143C" stroke="#2B5CE6" stroke-width="2.4" stroke-linejoin="round"/><circle cx="12.4" cy="22" r="2.2" fill="#fff"/></g>
  <text x="152" y="118" font-size="30" font-weight="500" fill="#0a0a0a">Nepal Payments</text>
  <text x="80" y="250" font-size="72" font-weight="500" fill="#0a0a0a" letter-spacing="-2.5">Nepali payments</text>
  <text x="80" y="330" font-size="72" font-weight="500" fill="#0a0a0a" letter-spacing="-2.5">for coding agents</text>
  <text x="80" y="400" font-size="27" fill="#5c5c5c">Agent Skill + tested adapters in TypeScript, Python, Java, Kotlin, PHP and Go</text>
  ${chips}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out}`);
