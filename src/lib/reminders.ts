// Maintenance reminders (Workflow-Spec step 16). Pure + dependency-free so the
// interval rules and due math are exhaustively testable. Timing is date-based;
// the message asks the customer to check their own mileage.

export type ReminderType =
  | "OIL_5000"
  | "OIL_10000"
  | "BATTERY"
  | "TIRE_ROTATION"
  | "BRAKES"
  | "AC_SERVICE"
  | "AIR_FILTER"
  | "COOLANT"
  | "TRANSMISSION";

export const REMINDER_TYPES: ReminderType[] = [
  "OIL_5000",
  "OIL_10000",
  "BATTERY",
  "TIRE_ROTATION",
  "BRAKES",
  "AC_SERVICE",
  "AIR_FILTER",
  "COOLANT",
  "TRANSMISSION",
];

// Months after the service date to send the reminder (spec-exact).
export const REMINDER_MONTHS: Record<ReminderType, number> = {
  OIL_5000: 2, // 5,000 km oil → check at 2 months
  OIL_10000: 4, // 10,000 km oil → check at 4 months
  BATTERY: 6,
  TIRE_ROTATION: 6,
  BRAKES: 6,
  AC_SERVICE: 6,
  AIR_FILTER: 12,
  COOLANT: 12,
  TRANSMISSION: 12,
};

/** Add whole months to a date without mutating the input (UTC-safe). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

/** When a reminder of this type is due, given the service date. */
export function dueDateFor(type: ReminderType, serviceDate: Date): Date {
  return addMonths(serviceDate, REMINDER_MONTHS[type]);
}

/** Is this reminder due to send yet? */
export function isDue(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() <= now.getTime();
}

type Lang = "en" | "ar" | "hi" | "ur";

// Service label per type, per language (English fallback).
const LABELS: Record<ReminderType, { en: string; ar: string }> = {
  OIL_5000: { en: "engine oil change", ar: "تغيير زيت المحرك" },
  OIL_10000: { en: "engine oil change", ar: "تغيير زيت المحرك" },
  BATTERY: { en: "battery check", ar: "فحص البطارية" },
  TIRE_ROTATION: { en: "tyre rotation", ar: "تدوير الإطارات" },
  BRAKES: { en: "brake check", ar: "فحص الفرامل" },
  AC_SERVICE: { en: "A/C service", ar: "صيانة المكيف" },
  AIR_FILTER: { en: "air filter change", ar: "تغيير فلتر الهواء" },
  COOLANT: { en: "coolant service", ar: "صيانة سائل التبريد" },
  TRANSMISSION: { en: "transmission service", ar: "صيانة ناقل الحركة" },
};

// The km hint for oil types (asks the customer to check their own mileage).
const OIL_KM: Partial<Record<ReminderType, number>> = {
  OIL_5000: 5000,
  OIL_10000: 10000,
};

/**
 * The reminder message body. Asks the customer to CHECK THEIR OWN MILEAGE rather
 * than assuming distance driven (spec). `vehicleLabel` e.g. "Toyota Land Cruiser".
 */
export function reminderBody(type: ReminderType, vehicleLabel: string, lang: Lang = "en"): string {
  const isAr = lang === "ar";
  const label = isAr ? LABELS[type].ar : LABELS[type].en;
  const km = OIL_KM[type];
  if (isAr) {
    const base = `تذكير صيانة لسيارتك ${vehicleLabel}: حان وقت ${label}.`;
    const tail = km
      ? ` يرجى التحقق من عداد المسافات — الخدمة مستحقة عند ${km.toLocaleString("en")} كم.`
      : " يرجى التحقق من عداد المسافات وحجز موعد عند الحاجة.";
    return base + tail;
  }
  const base = `Maintenance reminder for your ${vehicleLabel}: your ${label} is due.`;
  const tail = km
    ? ` Please check your mileage — it's due around ${km.toLocaleString("en")} km driven.`
    : " Please check your mileage and book a visit when convenient.";
  return base + tail;
}
