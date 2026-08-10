// READ-ONLY. Audits every Customer row against the tightened
// normalizeToE164 rules (GCC country-code gate, 2026-08-10). Reports:
//   - total customers
//   - how many would fail the send gate after the change (waId ?? phone
//     both fail to normalize)
//   - per-garage breakdown
//   - a sample of malformed values so intake can be checked
// Zero writes.
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";
import { normalizeToE164 } from "../src/lib/wa";

async function main() {
  const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(none)";
  if (!host.includes("supabase")) {
    console.error(`Refusing to run — DATABASE_URL host is ${host}, no 'supabase'.`);
    process.exit(1);
  }
  console.log(`Target: PROD (${host})\n`);

  const customers = await prisma.customer.findMany({
    select: {
      id: true, name: true, phone: true, waId: true,
      garage: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const total = customers.length;

  type Row = {
    id: string; name: string; phone: string | null; waId: string | null;
    garage: string; kind: "empty" | "malformed";
  };
  const failing: Row[] = [];
  const perGarage = new Map<string, { total: number; failing: number }>();

  for (const c of customers) {
    const gname = c.garage.name;
    const g = perGarage.get(gname) ?? { total: 0, failing: 0 };
    g.total += 1;
    const raw = c.waId ?? c.phone;
    const normalized = normalizeToE164(raw);
    if (normalized === null) {
      g.failing += 1;
      failing.push({
        id: c.id, name: c.name, phone: c.phone, waId: c.waId,
        garage: gname,
        kind: !raw || !raw.trim() ? "empty" : "malformed",
      });
    }
    perGarage.set(gname, g);
  }

  const empty = failing.filter((r) => r.kind === "empty").length;
  const malformed = failing.filter((r) => r.kind === "malformed").length;

  console.log(`--- Summary ---`);
  console.log(`Total customers          : ${total}`);
  console.log(`Sendable (has valid GCC) : ${total - failing.length}`);
  console.log(`Send blocked             : ${failing.length}`);
  console.log(`  · empty phone          : ${empty}`);
  console.log(`  · malformed value      : ${malformed}`);

  console.log(`\n--- Per garage ---`);
  const rows = Array.from(perGarage.entries())
    .map(([g, s]) => ({ garage: g, total: s.total, failing: s.failing, ok: s.total - s.failing }))
    .sort((a, b) => b.failing - a.failing || b.total - a.total);
  for (const r of rows) {
    console.log(`  ${r.garage.padEnd(30)} · ${String(r.ok).padStart(4)}/${String(r.total).padStart(4)} sendable · ${String(r.failing).padStart(4)} blocked`);
  }

  console.log(`\n--- Sample of malformed values (max 20) ---`);
  const sample = failing.filter((r) => r.kind === "malformed").slice(0, 20);
  for (const r of sample) {
    console.log(
      `  ${r.garage.padEnd(30)} · ${r.name.padEnd(20).slice(0, 20)} · phone=${JSON.stringify(r.phone)} waId=${JSON.stringify(r.waId)}`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
