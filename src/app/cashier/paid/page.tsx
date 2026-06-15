import { redirect } from "next/navigation";

// Legacy standalone route. The paid-invoices archive now lives under
// the Payments tab on /cashier (the 5-tab layout). Keep this URL
// alive for any existing bookmarks by redirecting to the canonical
// tab. Single source of truth for the paid-invoice rendering is
// /cashier?tab=payments.

export default function CashierPaidRedirect() {
  redirect("/cashier?tab=payments");
}
