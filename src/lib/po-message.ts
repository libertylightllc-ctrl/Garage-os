/**
 * Message templates — channel-agnostic bodies used by both WhatsApp
 * (wa.me link, encoded) and email (Resend, plain text + minimal HTML).
 *
 * Renamed from `wa-templates.ts` when email joined WhatsApp as a
 * second delivery channel for the supplier PO / RFQ. Both channels
 * MUST use the exact same body so the copy can't drift — one
 * function per message shape, called by whichever action fires.
 *
 * Language selection uses the recipient's own `lang` field when we
 * know it (customer.lang for invoices), or the shop owner's UI
 * locale for supplier-facing messages (a supplier record has no
 * language preference — the owner picks by drafting in EN or AR).
 */

type Lang = "en" | "ar" | "hi" | "ur";

function isArabic(lang: string | null | undefined): boolean {
    return lang === "ar";
}

/** AED 1234.56 (EN) / 1234.56 درهم (AR). */
function formatMoney(total: number, lang: Lang | string | null | undefined): string {
    // Two decimals to match how invoices display prices everywhere
    // else in the app. toFixed uses en-US grouping (none) which is
    // fine — we never render commas because a plain decimal reads
    // clearly on WhatsApp in both scripts.
    const n = total.toFixed(2);
    return isArabic(lang) ? `${n} درهم` : `AED ${n}`;
}

export interface InvoiceMessageInput {
    customer: { name: string; lang?: string | null };
    garage: { name: string };
    /**
     * Vehicle snapshot for the "For:" header line. Same field shape as
     * PurchaseOrderMessageInput's per-line vehicle context so both
     * message types render vehicles the same way (`make model year ·
     * plate · VIN … · engineSize fuelType · JC-N`). All fields
     * nullable — an intake-only vehicle may have make+model+plate
     * with year/VIN/engine missing, which just drops those bits from
     * the render.
     */
    vehicle: {
        make: string;
        model: string;
        year: number | null;
        plate: string | null;
        vin: string | null;
        engineSize: string | null;
        fuelType: string | null;
        jobNumber: number | null;
    };
    invoice: {
        /**
         * Already-formatted invoice number (e.g. "INV-2026-0001").
         * Caller formats via formatInvoiceNo(number, year) — the
         * builder stays year-agnostic.
         */
        number: string;
        subtotal: number;
        vatAmount: number;
        total: number;
        lines: Array<{ qty: number; description: string }>;
    };
    /** Origin without trailing slash (e.g. "https://garageos.shop"). */
    appUrl: string;
    /**
     * URL segment for the customer view — the Phase-2 publicToken
     * (raw base64url) or a Phase-1 HMAC-signed `<id>~<sig>`. The
     * builder doesn't care which; the resolver on the receive side
     * handles both. Field name kept for API compat.
     */
    invoiceId: string;
}

/**
 * Structured customer-facing invoice message — same pattern as
 * purchaseOrderMessage (AR, 2026-08-10): "I need this same thing for
 * invoice as well the same pattern and method". Body is paragraph-
 * separated so it reads well on WhatsApp:
 *
 *   Hi {name},
 *
 *   Tax Invoice {number} — from {garage}
 *
 *   For: {vehicle · plate · VIN · engine · JC-N}
 *
 *   {qty} × {description}   (one per line)
 *
 *   Subtotal: {subtotal}
 *   VAT (5%): {vat}
 *   Total: {total}
 *
 *   Please pay at the garage (cash or card).
 *
 *   View invoice: {url}
 *
 * Arabic mirror uses `مرحباً`, `فاتورة ضريبية`, `لأجل`, `عرض الفاتورة`.
 * Numbers stay Latin (same as the purchaseOrderMessage convention and
 * matches how invoice totals render on the customer page).
 */
export function invoiceMessage(input: InvoiceMessageInput): string {
    const { customer, garage, vehicle, invoice, appUrl, invoiceId } = input;
    const ar = isArabic(customer.lang);
    const link = `${appUrl}/c/invoice/${invoiceId}`;

    // Greeting.
    const greeting = ar ? `مرحباً ${customer.name}،` : `Hi ${customer.name},`;

    // Header line — matches PO's "{title} {number} — from {garage}".
    // Arabic drops the "from" preposition, matching purchaseOrderMessage's
    // Arabic branch which also renders the heading as
    // `${doc.title} ${doc.number} — ${garage.name}`.
    const invoiceLabel = ar ? "فاتورة ضريبية" : "Tax Invoice";
    const heading = ar
        ? `${invoiceLabel} ${invoice.number} — ${garage.name}`
        : `${invoiceLabel} ${invoice.number} — from ${garage.name}`;

    // Vehicle line — reuses PO's shape:
    //   {make} {model} {year} · {plate} · VIN {vin} · {engineSize} {fuelType} · JC-{n}
    // Any nullable field just drops out.
    const forLabel = ar ? "لأجل" : "For";
    const jcLabel = (n: number) => (ar ? `بطاقة عمل رقم ${n}` : `JC-${n}`);
    const mmy = [vehicle.make, vehicle.model, vehicle.year != null ? String(vehicle.year) : ""]
        .filter((s): s is string => Boolean(s))
        .join(" ");
    const vehicleBits: string[] = [];
    if (mmy) vehicleBits.push(mmy);
    if (vehicle.plate) vehicleBits.push(vehicle.plate);
    if (vehicle.vin) vehicleBits.push(`VIN ${vehicle.vin}`);
    const engine = [vehicle.engineSize, vehicle.fuelType]
        .filter((s): s is string => Boolean(s))
        .join(" ");
    if (engine) vehicleBits.push(engine);
    if (vehicle.jobNumber != null) vehicleBits.push(jcLabel(vehicle.jobNumber));
    const vehicleLine = vehicleBits.length ? `${forLabel}: ${vehicleBits.join(" · ")}` : "";

    // Items — "qty × description", one per line. Qty rendered as a
    // plain number so 1 shows as "1", not "1.00". Matches PO builder.
    const items = invoice.lines
        .map((l) => `${l.qty} × ${l.description}`)
        .join("\n");

    // Totals block — three-line paragraph. Money rendered via the
    // same formatMoney helper the customer's screen uses.
    const subtotalLabel = ar ? "المجموع الفرعي" : "Subtotal";
    const vatLabel = ar ? "ضريبة القيمة المضافة (٥٪)" : "VAT (5%)";
    const totalLabel = ar ? "الإجمالي" : "Total";
    const totals = [
        `${subtotalLabel}: ${formatMoney(invoice.subtotal, customer.lang)}`,
        `${vatLabel}: ${formatMoney(invoice.vatAmount, customer.lang)}`,
        `${totalLabel}: ${formatMoney(invoice.total, customer.lang)}`,
    ].join("\n");

    // Closing action prompt.
    const closing = ar
        ? "يرجى الدفع في الكراج (نقداً أو بالبطاقة)."
        : "Please pay at the garage (cash or card).";

    // URL line — labelled so the URL doesn't dangle on a bare line,
    // matching PO's `View document: {url}` shape.
    const linkLine = ar ? `عرض الفاتورة: ${link}` : `View invoice: ${link}`;

    return [greeting, heading, vehicleLine, items, totals, closing, linkLine]
        .filter((s) => s.length > 0)
        .join("\n\n");
}

// ── Supplier-facing PO / RFQ message ──────────────────────────────
//
// Outbound from the shop owner TO a supplier. Two shapes hidden
// behind one function — a real Purchase Order (has prices, is the
// commitment to buy) and a Request For Quotation (unpriced, asks
// the supplier to fill the prices in). The `isRfq` flag switches
// document title in the header line and adds a closing prompt asking
// for prices + availability.
//
// PO in this schema has no jobCard/vehicle link (the model ties to
// supplier + parts only), so there is no "job reference" line to
// include. If the supplier gave us their own quote number it lives
// on `reference` — we surface it because it lets THEM match our
// message against THEIR record. `note` (free-text) is opt-in
// context.

export interface PurchaseOrderMessageInput {
    /**
     * Document label + boolean flag.
     *   `title`  — already-localized string, e.g. "Purchase Order" or
     *              "طلب عرض سعر". Caller derives from t().
     *   `number` — visible identifier: our internal id fragment (last 6
     *              chars of the PO id) if we don't have a supplier
     *              reference, or the supplier's own reference when
     *              present.
     *   `isRfq`  — flips the closing prompt on.
     */
    doc: { title: string; number: string; isRfq: boolean };
    garage: { name: string };
    supplier: {
        /** Optional — greet by name when present; generic "Hi," otherwise. */
        contactPerson: string | null;
    };
    /**
     * Line items in display order. `description` renders VERBATIM —
     * it comes straight from Part.name and passes through to the
     * supplier's WhatsApp / email. Do NOT concatenate the "please
     * quote" marker into it; the builder appends that as its own
     * segment based on `perLineUnpriced[i]` and the caller's own
     * doc-kind classification lives outside this shape (see
     * `poDocKind` in @/lib/po-doc-kind).
     */
    lines: Array<{ qty: number; description: string }>;
    /**
     * Per-line "unpriced" flag, matched to `lines` by INDEX. When
     * `true`, the body renders a "(please quote)" suffix on that
     * line so the supplier knows which items to quote in a mixed
     * document. Callers derive this via `isLineUnpriced` from
     * @/lib/po-doc-kind — never by inspecting the description or
     * the qty×cost total, which would double-count the description
     * field's job.
     */
    perLineUnpriced: readonly boolean[];
    /** Optional free-text note from PO.note. Rendered as its own paragraph. */
    note: string | null;
    /**
     * Public signed URL for the read-only supplier view — appended as
     * the LAST line of the body. Both channels (WhatsApp + email) share
     * it, so the supplier gets the same clickable link regardless of
     * how the owner sent the message. Caller builds via `signId("po",
     * po.id)` + `<appUrl>/c/po/<token>` (see /c/po/[id]).
     */
    publicUrl: string;
    /**
     * Vehicle context resolved from Part.autoCreatedFromLineId. Kept
     * out of the sender's control — the caller passes what the DB
     * traversal produced, and the builder chooses the header vs.
     * inline shape from `distinct.length`. Line ids are matched to
     * `lines` by INDEX (both arrays are in display order); a null
     * entry means the resolver couldn't find a vehicle for that
     * line and the body renders "(no vehicle linked)" inline.
     */
    perLineVehicle: Array<import("./po-vehicle").VehicleContext | null>;
    distinctVehicles: Array<import("./po-vehicle").VehicleContext>;
    /**
     * Message locale. Supplier records don't carry a language
     * preference, so the caller picks based on the shop owner's UI
     * locale — the owner is the one drafting; the supplier reads
     * whichever script the owner sent.
     */
    lang: "en" | "ar";
}

export function purchaseOrderMessage(input: PurchaseOrderMessageInput): string {
    const {
        doc,
        garage,
        supplier,
        lines,
        note,
        publicUrl,
        perLineVehicle,
        perLineUnpriced,
        distinctVehicles,
        lang,
    } = input;
    const ar = isArabic(lang);
    // The message body is built as a list of paragraphs. Blank strings
    // between them become blank lines when we join — reads well on
    // WhatsApp's flow-wrap layout.
    const greeting = supplier.contactPerson
        ? ar
            ? `مرحباً ${supplier.contactPerson}،`
            : `Hi ${supplier.contactPerson},`
        : ar
        ? "مرحباً،"
        : "Hi,";
    const heading = ar
        ? `${doc.title} ${doc.number} — ${garage.name}`
        : `${doc.title} ${doc.number} — from ${garage.name}`;

    // Vehicle strategy — three shapes, one per case:
    //   1 distinct vehicle → header line "For: …", plain items below.
    //   ≥2 distinct        → header line lists them all, items get
    //                        (JC-N · Make Model) inline for the ones
    //                        that resolved.
    //   0 resolved         → no header line at all — better than a
    //                        false "For: —".
    // Unresolved lines in any case get "(no vehicle linked)" inline
    // so the supplier can see we don't know, rather than guessing.
    const forLabel = ar ? "لأجل" : "For";
    const jcLabel = (n: number) => (ar ? `بطاقة عمل رقم ${n}` : `JC-${n}`);
    const vehicleLine = (v: import("./po-vehicle").VehicleContext): string => {
        // All fields nullable as of 2026-08-02 (standalone / free-text
        // vehicles may have only make + model, or only a plate). Rows
        // that come back null just don't render.
        const bits: string[] = [];
        const mmy = [v.make, v.model, v.year != null ? String(v.year) : ""]
            .filter((s): s is string => Boolean(s))
            .join(" ");
        if (mmy) bits.push(mmy);
        if (v.plate) bits.push(v.plate);
        if (v.vin) bits.push(`VIN ${v.vin}`);
        const engine = [v.engineSize, v.fuelType]
            .filter((s): s is string => Boolean(s))
            .join(" ");
        if (engine) bits.push(engine);
        if (v.jobNumber != null) bits.push(jcLabel(v.jobNumber));
        return bits.join(" · ");
    };
    const noVehicleTag = ar ? "(لا يوجد مركبة مرتبطة)" : "(no vehicle linked)";
    const inlineTag = (v: import("./po-vehicle").VehicleContext): string => {
        const nameBits = [v.make, v.model].filter(Boolean).join(" ");
        const parts: string[] = [];
        if (v.jobNumber != null) parts.push(jcLabel(v.jobNumber));
        if (nameBits) parts.push(nameBits);
        return parts.length ? ` (${parts.join(" · ")})` : "";
    };
    const singleVehicle = distinctVehicles.length === 1;
    let vehicleHeader = "";
    if (distinctVehicles.length === 1) {
        vehicleHeader = `${forLabel}: ${vehicleLine(distinctVehicles[0])}`;
    } else if (distinctVehicles.length > 1) {
        const header = ar ? "لأجل المركبات" : "For vehicles";
        vehicleHeader = `${header}:\n${distinctVehicles
            .map((v) => `• ${vehicleLine(v)}`)
            .join("\n")}`;
    }

    // "Please quote" suffix — a SEPARATE segment appended after the
    // vehicle tag (or straight after the description when there's no
    // vehicle tag). Deliberately NOT concatenated into
    // `l.description`, which passes through verbatim: description
    // is user-facing text that lives in the DB (Part.name) and gets
    // shipped to WhatsApp. Marker rendering is a display-time
    // decision by this builder, not a stored string. See po-message
    // input contract.
    const pleaseQuoteTag = ar ? "(برجاء إفادتنا بالسعر)" : "(please quote)";

    const items = lines
        .map((l, i) => {
            const v = perLineVehicle[i] ?? null;
            const base = `${l.qty} × ${l.description}`;
            // Header + tagging rules by shape:
            //   singleVehicle + line resolves      → bare (header names it)
            //   singleVehicle + line unresolved    → "(no vehicle linked)"
            //                                        so the reader does not
            //                                        misread it as being
            //                                        for the header's car
            //   multi-vehicle + resolved           → inline (JC-N · Make Model)
            //   multi-vehicle + unresolved         → "(no vehicle linked)"
            //   no header (0 resolved) + resolved  → inline (won't happen)
            //   no header + unresolved             → "(no vehicle linked)"
            let out: string;
            if (singleVehicle && v) out = base;
            else if (v) out = base + inlineTag(v);
            else out = `${base} ${noVehicleTag}`;
            // "(please quote)" appended AFTER whatever vehicle tag
            // this line already carries — a mixed RFQ needs the
            // supplier to see which specific lines to price, and
            // the tag has to survive alongside vehicle context.
            if (perLineUnpriced[i]) out = `${out} ${pleaseQuoteTag}`;
            return out;
        })
        .join("\n");
    const closing = doc.isRfq
        ? ar
            ? "برجاء إفادتنا بالأسعار والتوفر لكل بند."
            : "Please share prices and availability for each item."
        : "";
    // `note` renders verbatim (owner may have typed context like
    // "urgent" or a delivery address) — trim to strip any accidental
    // leading/trailing whitespace.
    const noteLine = note?.trim() ? note.trim() : "";
    // Public link is ALWAYS the last line — the supplier expects a
    // single clickable URL at the end regardless of channel. Label
    // introduces it so the URL doesn't dangle on a bare line.
    const linkLine = ar
        ? `عرض المستند: ${publicUrl}`
        : `View document: ${publicUrl}`;
    return [greeting, heading, vehicleHeader, items, noteLine, closing, linkLine]
        .filter((s) => s.length > 0)
        .join("\n\n");
}
