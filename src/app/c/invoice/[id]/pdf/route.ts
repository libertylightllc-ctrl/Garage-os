import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveDocumentToken } from "@/lib/document-tokens";
import { formatInvoiceNo } from "@/lib/billing";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

/**
 * Public PDF endpoint for the customer's invoice.
 *
 * Auth: the same signed token that gates /c/invoice/[id]. If the
 * token doesn't verify, we 404 — never 401 — so an attacker with a
 * bad token can't distinguish "invoice exists but bad token" from
 * "invoice doesn't exist." Same shape as the HTML customer route.
 *
 * The token here is the SIGNED version (not the raw DB id) because
 * that's what /c/invoice/[id] itself accepts. `renderInvoicePdf`
 * takes a RAW id and re-signs it — a small duplication that keeps
 * the internal helper single-input.
 *
 * Filename: `Invoice-{formatted-number}.pdf` so a customer saving
 * multiple invoices gets sortable names. `Content-Disposition:
 * attachment` forces a download on desktop and prompts the mobile
 * OS's save dialog rather than opening in the browser tab (which
 * many WhatsApp in-app browsers can't do reliably).
 *
 * The whole request is Node runtime + up to 30 s — Chromium
 * launches take ~2 s cold, so cap generously.
 */

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id: token } = await params;
    const id = await resolveDocumentToken("invoice", token);
    if (!id) return new NextResponse("Not Found", { status: 404 });

    // We only need `number` + `issuedAt` to build the filename — the
    // actual render round-trips through the signed URL and re-loads
    // everything itself. Missing invoice → 404, not 500.
    const inv = await prisma.invoice.findUnique({
        where: { id },
        select: { number: true, issuedAt: true },
    });
    if (!inv) return new NextResponse("Not Found", { status: 404 });

    try {
        const pdf = await renderInvoicePdf(id);
        const filename = `Invoice-${formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}.pdf`;
        return new NextResponse(new Uint8Array(pdf), {
            status: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${filename}"`,
                // Never cache — the invoice may be edited or paid
                // between renders, and the file is small.
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        console.error("[invoice-pdf] render failed", err);
        return new NextResponse("PDF generation failed", { status: 502 });
    }
}
