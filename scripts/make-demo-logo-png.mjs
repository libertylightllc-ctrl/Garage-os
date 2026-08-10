// One-shot generator for the demo garage's local test logo. Writes a
// 400×120 PNG using sharp (already in the dep tree) — navy background,
// amber "DEMO GARAGE" text plus subtitle so AR can distinguish this
// visually from the GarageOS default fallback at a glance.
//
// Output: .uploads/logo-demo-real.png (served via /api/files/…)
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120" width="400" height="120">
  <rect width="400" height="120" fill="#0f172a"/>
  <text x="200" y="56" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="30" font-weight="700" fill="#f59e0b" text-anchor="middle" letter-spacing="3">DEMO GARAGE</text>
  <text x="200" y="88" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13" font-weight="500" fill="#e2e8f0" text-anchor="middle" letter-spacing="4">AUTHORIZED SERVICE — DUBAI</text>
  <circle cx="40" cy="60" r="22" fill="none" stroke="#f59e0b" stroke-width="3"/>
  <circle cx="360" cy="60" r="22" fill="none" stroke="#f59e0b" stroke-width="3"/>
</svg>`;

const png = await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toBuffer();

const outPath = path.resolve(".uploads", "logo-demo-real.png");
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
