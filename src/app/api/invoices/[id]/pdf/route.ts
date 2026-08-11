import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatInvoiceNo } from "@/lib/billing";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

/**
 * Staff-only PDF endpoint. Same PDF as /c/invoice/[id]/pdf but keyed
 * off the RAW invoice id + auth cookie instead of a signed token, so
 * a cashier / owner / master can grab the PDF straight from the
 * internal invoice page.
 *
 * Auth: signed-in staff whose garageId matches the invoice's.
 *   - Not signed in → 401
 *   - Signed in but wrong garage → 404 (never leak cross-garage
 *     existence via status code)
 *
 * Same nodejs runtime + 30 s cap as the public route.
 */

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }

    const { id } = await params;
    const inv = await prisma.invoice.findFirst({
        where: { id, garageId: session.user.garageId },
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
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        console.error("[invoice-pdf] staff render failed", err);
        return new NextResponse("PDF generation failed", { status: 502 });
    }
}
