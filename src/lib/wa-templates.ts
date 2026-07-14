/**
 * Message templates for the "Send via WhatsApp" button.
 *
 * Every template takes the ambient data (customer, invoice/estimate/
 * reminder, appUrl, lang) and returns the plain-text body that will be
 * URL-encoded into a wa.me link. Kept in one file so the copy is easy
 * to review and touch up. Language selection uses the customer's own
 * `lang` field ("en" | "ar" | …); anything not "ar" falls back to EN.
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
