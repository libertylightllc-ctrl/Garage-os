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
    vehicle: { make: string; model: string };
    invoice: { total: number; number: number | string };
    /** Origin without trailing slash (e.g. "https://garageos.shop"). */
    appUrl: string;
    /** Invoice id — becomes /c/invoice/{id}. */
    invoiceId: string;
}

/**
 * "Hi {name}, your invoice for the {make} {model} is ready. Total
 *  AED {total}. View & pay: {link}"  — or the Arabic equivalent.
 *
 * Deliberately does NOT include the invoice NUMBER in the body — the
 * link opens a page that shows it, and shorter WhatsApp messages get
 * higher engagement in pilot. If you want the number in the message
 * later, add it here.
 */
export function invoiceMessage(input: InvoiceMessageInput): string {
    const { customer, vehicle, invoice, appUrl, invoiceId } = input;
    const link = `${appUrl}/c/invoice/${invoiceId}`;
    const money = formatMoney(invoice.total, customer.lang);
    if (isArabic(customer.lang)) {
        return `مرحباً ${customer.name}، فاتورتك لـ ${vehicle.make} ${vehicle.model} جاهزة. الإجمالي ${money}. عرض والدفع: ${link}`;
    }
    return `Hi ${customer.name}, your invoice for the ${vehicle.make} ${vehicle.model} is ready. Total ${money}. View & pay: ${link}`;
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
        const bits: string[] = [];
        bits.push([v.make, v.model, v.year != null ? String(v.year) : ""].filter(Boolean).join(" "));
        bits.push(v.plate);
        if (v.vin) bits.push(`VIN ${v.vin}`);
        const engine = [v.engineSize, v.fuelType].filter(Boolean).join(" ");
        if (engine) bits.push(engine);
        bits.push(jcLabel(v.jobNumber));
        return bits.filter(Boolean).join(" · ");
    };
    const noVehicleTag = ar ? "(لا يوجد مركبة مرتبطة)" : "(no vehicle linked)";
    const inlineTag = (v: import("./po-vehicle").VehicleContext): string =>
        ar
            ? ` (${jcLabel(v.jobNumber)} · ${v.make} ${v.model})`
            : ` (${jcLabel(v.jobNumber)} · ${v.make} ${v.model})`;
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
