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

// Receptionist languages (spec §13: Arabic, English, Hindi, Urdu). English is the fallback.
export type Lang = "ar" | "en" | "hi" | "ur";
type L<T> = { en: T } & Partial<Record<Lang, T>>;
function pick<T>(m: L<T>, lang: Lang): T {
  return m[lang] ?? m.en;
}

export function holdingReply(lang: Lang): string {
  return pick(
    {
      en: "Thanks! Let me confirm with the team and get right back to you.",
      ar: "شكرًا لك! دعني أتأكد من الفريق وأعود إليك حالًا.",
      hi: "धन्यवाद! मैं टीम से पुष्टि करके तुरंत आपको बताता हूँ।",
      ur: "شکریہ! میں ٹیم سے تصدیق کر کے فوراً آپ کو بتاتا ہوں۔",
    },
    lang,
  );
}

export function handoffReply(lang: Lang): string {
  return pick(
    {
      en: "I’m connecting you with one of our team now.",
      ar: "سأوصلك بأحد أعضاء فريقنا الآن.",
      hi: "मैं अभी आपको हमारी टीम के किसी सदस्य से जोड़ रहा हूँ।",
      ur: "میں ابھی آپ کو ہماری ٹیم کے کسی فرد سے ملا رہا ہوں۔",
    },
    lang,
  );
}

export function autoReply(
  intent: Intent,
  lang: Lang,
  data: { statusLabel?: string; link?: string; bookLink?: string },
): string {
  switch (intent) {
    case "STATUS":
      return data.statusLabel
        ? pick(
            {
              en: `Your car's current status: ${data.statusLabel}.`,
              ar: `حالة سيارتك الآن: ${data.statusLabel}.`,
              hi: `आपकी कार की वर्तमान स्थिति: ${data.statusLabel}.`,
              ur: `آپ کی گاڑی کی موجودہ حالت: ${data.statusLabel}.`,
            },
            lang,
          )
        : pick(
            {
              en: "I don't see an active job for your car — would you like to book one?",
              ar: "لا أرى مهمة نشطة لسيارتك حاليًا — هل تريد حجز موعد؟",
              hi: "मुझे आपकी कार के लिए कोई सक्रिय कार्य नहीं दिख रहा — क्या आप बुकिंग करना चाहेंगे?",
              ur: "مجھے آپ کی گاڑی کے لیے کوئی فعال کام نظر نہیں آتا — کیا آپ بکنگ کرنا چاہیں گے؟",
            },
            lang,
          );
    case "HOURS":
      return pick(
        {
          en: "Our hours: Sat–Thu, 8am–8pm.",
          ar: "ساعات العمل: السبت–الخميس من ٨ صباحًا إلى ٨ مساءً.",
          hi: "हमारे काम के घंटे: शनिवार–गुरुवार, सुबह 8 से रात 8 बजे।",
          ur: "ہمارے اوقاتِ کار: ہفتہ–جمعرات، صبح 8 سے رات 8 بجے۔",
        },
        lang,
      );
    case "BOOKING":
      return pick(
        {
          en: `Happy to help! Book your service here: ${data.bookLink}`,
          ar: `بكل سرور! احجز خدمتك من هنا: ${data.bookLink}`,
          hi: `खुशी से! अपनी सर्विस यहाँ बुक करें: ${data.bookLink}`,
          ur: `بخوشی! اپنی سروس یہاں بک کریں: ${data.bookLink}`,
        },
        lang,
      );
    case "INVOICE":
      return data.link
        ? pick(
            {
              en: `Here's your invoice and payment link: ${data.link}`,
              ar: `هذه فاتورتك ورابط الدفع: ${data.link}`,
              hi: `यह रही आपकी रसीद और भुगतान लिंक: ${data.link}`,
              ur: `یہ آپ کا انوائس اور ادائیگی لنک ہے: ${data.link}`,
            },
            lang,
          )
        : pick(
            {
              en: "There's no invoice ready yet.",
              ar: "لا توجد فاتورة جاهزة بعد.",
              hi: "अभी कोई रसीद तैयार नहीं है।",
              ur: "ابھی کوئی انوائس تیار نہیں ہے۔",
            },
            lang,
          );
    default:
      return pick(
        { en: "How can I help?", ar: "كيف يمكنني مساعدتك؟", hi: "मैं कैसे मदद कर सकता हूँ?", ur: "میں کیسے مدد کر سکتا ہوں؟" },
        lang,
      );
  }
}

export function draftFor(intent: Intent, lang: Lang): string {
  if (intent === "PRICE")
    return pick(
      {
        en: "[draft] The estimated total is AED ___ incl. VAT. Shall we proceed?",
        ar: "[مسودة] إجمالي السعر التقديري هو ___ درهم شامل الضريبة. هل تريد المتابعة؟",
        hi: "[ड्राफ्ट] अनुमानित कुल राशि ___ AED है (वैट सहित)। क्या हम आगे बढ़ें?",
        ur: "[ڈرافٹ] تخمینی کل رقم ___ AED ہے (ویٹ سمیت)۔ کیا ہم آگے بڑھیں؟",
      },
      lang,
    );
  if (intent === "DEADLINE")
    return pick(
      {
        en: "[draft] We expect the car to be ready by ___.",
        ar: "[مسودة] من المتوقع أن تكون السيارة جاهزة بحلول ___.",
        hi: "[ड्राफ्ट] कार ___ तक तैयार होने की उम्मीद है।",
        ur: "[ڈرافٹ] گاڑی ___ تک تیار ہونے کی توقع ہے۔",
      },
      lang,
    );
  return pick(
    {
      en: "[draft] Regarding the diagnosis: ___.",
      ar: "[مسودة] بخصوص التشخيص: ___.",
      hi: "[ड्राफ्ट] निदान के बारे में: ___।",
      ur: "[ڈرافٹ] تشخیص کے بارے میں: ___۔",
    },
    lang,
  );
}
