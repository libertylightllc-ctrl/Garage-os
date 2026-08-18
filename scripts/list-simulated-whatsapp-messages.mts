// List every WhatsAppMessage row marked simulated=true, with dates +
// short body preview + customer name/phone. Read-only. AR runs this
// post-deploy of migration 20260819140000_mark_simulated_whatsapp_messages
// to eyeball which of the 4 fabricated rows are their own recent
// testing versus older damage.
//
// Kept as a permanent script (not a probe) — future audit questions
// about "were any simulated rows written after the tools were
// deleted?" get an immediate answer. Post-deletion the answer must
// stay "no new rows since 2026-08-19"; if that ever grows, a
// simulation writer has snuck back in.
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const rows = await prisma.whatsAppMessage.findMany({
    where: { simulated: true },
    select: {
      id: true,
      createdAt: true,
      direction: true,
      body: true,
      waMessageId: true,
      thread: {
        select: {
          garageId: true,
          customer: { select: { name: true, phone: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Simulated WhatsAppMessage rows: ${rows.length}`);
  for (const r of rows) {
    const cust = r.thread.customer;
    console.log(
      `  ${r.createdAt.toISOString()}  ${r.direction}  ${cust.name}  <${cust.phone}>  ` +
      `id=${r.id}  wamid=${r.waMessageId}\n    body: "${(r.body ?? "").slice(0, 100)}"`,
    );
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
