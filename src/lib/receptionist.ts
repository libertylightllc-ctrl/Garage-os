// AI receptionist routing — propose / confirm / handoff. The classifier is the HARD
// guardrail: anything about a price, quote, diagnosis, or deadline is forced to PROPOSE
// (the AI never states a final price or commitment unconfirmed). Routine messages are AUTO.
// Anything frustrated / out-of-scope / low-confidence goes to HANDOFF.

export type Route = "AUTO" | "PROPOSE" | "HANDOFF";
export type Intent =
  | "BOOKING"
  | "STATUS"
  | "HOURS"
  | "INVOICE"
  | "PRICE"
  | "DIAGNOSIS"
  | "DEADLINE"
  | "FRUSTRATION"
  | "UNKNOWN";

export interface Classification {
  route: Route;
  intent: Intent;
}

export function classifyConversation(text: string): Classification {
  const q = (text || "").toLowerCase();

  // 1) HANDOFF — anger / explicit human ask (checked first; safety over automation)
  if (
    /(angry|terrible|awful|worst|refund|complain|manager|speak to (a )?human|agent|غاضب|سيّئ|سيء|أسوأ|استرداد|شكوى|مدير|موظف|بشري)/.test(
      q,
    ) ||
    text.includes("!!!")
  ) {
    return { route: "HANDOFF", intent: "FRUSTRATION" };
  }

  // 2) PROPOSE — price / quote / diagnosis / deadline (never auto-commit)
  if (/(price|cost|how much|quote|estimate|discount|سعر|تكلفة|كم.*(سعر|تكلفة|يكلف)|عرض سعر|خصم)/.test(q))
    return { route: "PROPOSE", intent: "PRICE" };
  if (/(what'?s wrong|diagnos|the problem|why is it|عطل|تشخيص|المشكلة|ما المشكلة)/.test(q))
    return { route: "PROPOSE", intent: "DIAGNOSIS" };
  if (/(when.*(ready|done|finish)|how long|deadline|by when|متى.*(جاهز|تخلص|تنتهي)|كم يستغرق|كم.*وقت)/.test(q))
    return { route: "PROPOSE", intent: "DEADLINE" };

  // 3) AUTO — routine
  if (/(ready|done yet|status|finished|update|جاهز|جاهزة|خلصت|انتهت|الحالة|وضع)/.test(q))
    return { route: "AUTO", intent: "STATUS" };
  if (/(hour|open|close|location|address|where are you|ساعات|تفتح|مفتوح|العنوان|الموقع|وين)/.test(q))
    return { route: "AUTO", intent: "HOURS" };
  if (/(book|appointment|service|احجز|حجز|موعد|خدمة|صيانة)/.test(q))
    return { route: "AUTO", intent: "BOOKING" };
  if (/(invoice|bill|receipt|pay|فاتورة|دفع|إيصال|حساب)/.test(q))
    return { route: "AUTO", intent: "INVOICE" };

  // 4) Out of scope / low confidence -> human
  return { route: "HANDOFF", intent: "UNKNOWN" };
}

type Lang = "ar" | "en";

export function holdingReply(lang: Lang): string {
  return lang === "ar"
    ? "شكرًا لك! دعني أتأكد من الفريق وأعود إليك حالًا."
    : "Thanks! Let me confirm with the team and get right back to you.";
}

export function handoffReply(lang: Lang): string {
  return lang === "ar"
    ? "سأوصلك بأحد أعضاء فريقنا الآن."
    : "I’m connecting you with one of our team now.";
}

export function autoReply(
  intent: Intent,
  lang: Lang,
  data: { statusLabel?: string; link?: string; bookLink?: string },
): string {
  const ar = lang === "ar";
  switch (intent) {
    case "STATUS":
      return data.statusLabel
        ? ar
          ? `حالة سيارتك الآن: ${data.statusLabel}.`
          : `Your car's current status: ${data.statusLabel}.`
        : ar
          ? "لا أرى مهمة نشطة لسيارتك حاليًا — هل تريد حجز موعد؟"
          : "I don't see an active job for your car — would you like to book one?";
    case "HOURS":
      return ar
        ? "ساعات العمل: السبت–الخميس من ٨ صباحًا إلى ٨ مساءً."
        : "Our hours: Sat–Thu, 8am–8pm.";
    case "BOOKING":
      return ar
        ? `بكل سرور! احجز خدمتك من هنا: ${data.bookLink}`
        : `Happy to help! Book your service here: ${data.bookLink}`;
    case "INVOICE":
      return data.link
        ? ar
          ? `هذه فاتورتك ورابط الدفع: ${data.link}`
          : `Here's your invoice and payment link: ${data.link}`
        : ar
          ? "لا توجد فاتورة جاهزة بعد."
          : "There's no invoice ready yet.";
    default:
      return ar ? "كيف يمكنني مساعدتك؟" : "How can I help?";
  }
}

export function draftFor(intent: Intent, lang: Lang): string {
  const ar = lang === "ar";
  if (intent === "PRICE")
    return ar
      ? "[مسودة] إجمالي السعر التقديري هو ___ درهم شامل الضريبة. هل تريد المتابعة؟"
      : "[draft] The estimated total is AED ___ incl. VAT. Shall we proceed?";
  if (intent === "DEADLINE")
    return ar
      ? "[مسودة] من المتوقع أن تكون السيارة جاهزة بحلول ___."
      : "[draft] We expect the car to be ready by ___.";
  return ar
    ? "[مسودة] بخصوص التشخيص: ___."
    : "[draft] Regarding the diagnosis: ___.";
}
