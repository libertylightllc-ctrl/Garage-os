import "./lib/target-local.mjs";

// One-shot seed for the three "content-moved" surfaces AR wants to
// click-verify before pushing 6601b16:
//   /invoices/[id]        — 3 states (OVERDUE / PARTIAL / PAID)
//   /estimates/[id]       — status caption below header
//   /owner/purchasing/[id] — status pill below header

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const garageId = "demo-garage";

  const job = await prisma.jobCard.findUnique({
    where: { id: "print-12line-2026-07-24" },
    include: { vehicle: true },
  });
  if (!job) throw new Error("Print fixture missing — seed-print-12line-fixture first");

  const now = new Date("2026-07-24T10:00:00+04:00");
  const past = new Date("2026-06-01T00:00:00+04:00"); // dueDate < now → overdue
  const future = new Date("2026-08-30T00:00:00+04:00"); // dueDate > now → not overdue

  // Bump numbering above whatever's already in the DB.
  const highest = await prisma.invoice.aggregate({
    where: { garageId },
    _max: { number: true },
  });
  const nextInvoiceNumber = (highest._max.number ?? 0) + 1;

  const states = [
    {
      id: "hdr-inv-overdue",
      number: nextInvoiceNumber,
      dueDate: past,
      paid: 0,
      total: 504,
      label: "OVERDUE",
    },
    {
      id: "hdr-inv-partial",
      number: nextInvoiceNumber + 1,
      dueDate: future,
      paid: 200,
      total: 504,
      label: "PARTIAL",
    },
    {
      id: "hdr-inv-paid",
      number: nextInvoiceNumber + 2,
      dueDate: future,
      paid: 504,
      total: 504,
      label: "PAID",
    },
  ];

  const urls: Record<string, string> = {};
  for (const s of states) {
    let inv = await prisma.invoice.findUnique({ where: { id: s.id } });
    if (!inv) {
      inv = await prisma.invoice.create({
        data: {
          id: s.id,
          garageId,
          jobCardId: job.id,
          number: s.number,
          issuedAt: now,
          dueDate: s.dueDate,
          subtotal: 480,
          vatAmount: 24,
          total: s.total,
          clearanceStatus: "NA",
        },
      });
      await prisma.invoiceLine.createMany({
        data: [
          { invoiceId: inv.id, kind: "LABOR", description: "AC compressor service", qty: 1, unitPrice: 180, lineTotal: 180 },
          { invoiceId: inv.id, kind: "PART", description: "Cabin air filter", qty: 1, unitPrice: 60, lineTotal: 60 },
          { invoiceId: inv.id, kind: "LABOR", description: "Battery drain diagnosis", qty: 2, unitPrice: 100, lineTotal: 200 },
          { invoiceId: inv.id, kind: "PART", description: "Rear wiper blade", qty: 1, unitPrice: 40, lineTotal: 40 },
        ],
      });
      if (s.paid > 0) {
        await prisma.payment.create({
          data: {
            invoiceId: inv.id,
            amount: s.paid,
            method: "CASH",
            paidAt: now,
          },
        });
      }
    }
    urls[`invoice_${s.label}`] = `http://localhost:3000/invoices/${inv.id}`;
  }

  // Purchase order — a supplier + one DRAFT PO with a reference and a
  // couple of lines so the status pill and lines caption both render.
  const SUPPLIER_ID = "hdr-supplier-01";
  const PO_ID = "hdr-po-01";
  await prisma.supplier.upsert({
    where: { id: SUPPLIER_ID },
    update: {},
    create: {
      id: SUPPLIER_ID,
      garageId,
      name: "NGK Auto Parts Trading LLC",
      phone: "+971 4 555 1234",
    },
  });
  let po = await prisma.purchaseOrder.findUnique({ where: { id: PO_ID } });
  if (!po) {
    po = await prisma.purchaseOrder.create({
      data: {
        id: PO_ID,
        garageId,
        supplierId: SUPPLIER_ID,
        status: "ORDERED",
        reference: "SP-2026-9871",
        note: "For JC-2026-0013 — Toyota Land Cruiser cabin filter + wiper.",
      },
    });
  }

  urls.estimate_staff = "http://localhost:3000/estimates/doc-header-estimate-01";
  urls.purchase_order = `http://localhost:3000/owner/purchasing/${po.id}`;
  urls.print_job_card = `http://localhost:3000/advisor/jobs/${job.id}/print`;

  console.log(JSON.stringify(urls, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
