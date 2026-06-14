// Render-time translation for invoice + estimate line-item descriptions.
//
// The cashier types descriptions in free form (usually English). When
// the customer's locale is Arabic, the invoice render swaps known
// service names to their Arabic equivalent so the printed/sent doc
// reads cleanly. Unknown descriptions (custom line items, parts that
// aren't in the dictionary) pass through untouched.
//
// Stored data is NEVER mutated — this is a display helper only. The
// estimate/invoice line.description column keeps whatever the cashier
// typed; the snapshot rule for invoices still holds.
//
// Lookup is normalized: case-insensitive, trimmed, internal whitespace
// collapsed. 'Engine oil', 'engine  oil', and 'ENGINE OIL  ' all hit
// the same entry. left/right variants are recognised as suffixes so
// 'Ball joint right' / 'Ball joint left' map without needing two rows
// each in the table.

const NORMALIZE = /\s+/g;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(NORMALIZE, " ");
}

// Dictionary — keep small + curated. Aim is the long-tail of items a
// real workshop bills most often. Easy to extend; entries are
// English (canonical, lowercased) → Arabic.
//
// Sources for the Arabic strings: common UAE/KSA workshop usage
// (e.g. zayt muharrik for engine oil, faramel for brakes). Reviewed
// for everyday auto-shop register, not classical Arabic.
const DICTIONARY: Record<string, string> = {
  // Fluids / lube
  "engine oil": "زيت محرك",
  "gear oil": "زيت الجير",
  "transmission oil": "زيت ناقل الحركة",
  "brake fluid": "زيت الفرامل",
  "coolant": "سائل التبريد",
  "radiator coolant": "سائل تبريد الرديتر",
  "power steering fluid": "زيت الدركسيون",
  "ac refrigerant": "غاز التكييف",
  "freon": "فريون",

  // Filters
  "oil filter": "فلتر الزيت",
  "air filter": "فلتر الهواء",
  "cabin filter": "فلتر مكيف",
  "fuel filter": "فلتر البنزين",

  // Engine
  "head gasket": "حشية رأس المحرك",
  "valve cover gasket": "حشية غطاء الصبابات",
  "spark plug": "بوجي",
  "spark plugs": "بواجي",
  "timing belt": "سير التايمنق",
  "timing chain": "جنزير التايمنق",
  "drive belt": "سير الديناما",
  "alternator": "الداينمو",
  "starter motor": "السلف",
  "water pump": "طرمبة الماء",
  "fuel pump": "طرمبة البنزين",
  "radiator": "الرديتر",
  "thermostat": "ثرموستات",

  // Brakes
  "brake pads": "فحمات الفرامل",
  "brake pads front": "فحمات الفرامل الأمامية",
  "brake pads rear": "فحمات الفرامل الخلفية",
  "brake discs": "أقراص الفرامل",
  "brake rotors": "أقراص الفرامل",
  "brake calipers": "كاليبر الفرامل",
  "brake service": "صيانة الفرامل",

  // Suspension / steering
  "ball joint": "ركبة محورية",
  "ball joint right": "ركبة محورية يمين",
  "ball joint left": "ركبة محورية يسار",
  "tie rod": "بلية المقصات",
  "tie rod end": "بلية طرفية",
  "control arm": "ميزان",
  "shock absorber": "مساعد",
  "shock absorbers": "مساعدات",
  "shock absorbers front": "مساعدات أمامية",
  "shock absorbers rear": "مساعدات خلفية",
  "suspension bushes": "جلب التعليق",
  "suspension bushes set": "طقم جلب التعليق",
  "stabilizer bar": "عمود الاتزان",
  "stabilizer link": "وصلة الاتزان",
  "wheel bearing": "رمان البلف",
  "wheel alignment": "ضبط زوايا العجلات",
  "wheel balancing": "موازنة الإطارات",

  // Tyres / wheels
  "tyre": "إطار",
  "tyres": "إطارات",
  "tyre rotation": "تدوير الإطارات",
  "tire": "إطار",
  "tires": "إطارات",
  "tire rotation": "تدوير الإطارات",
  "puncture repair": "إصلاح ثقب الإطار",

  // Electrical
  "battery": "البطارية",
  "battery replacement": "تغيير البطارية",
  "headlight": "كشاف أمامي",
  "headlights": "الكشافات الأمامية",
  "tail light": "كشاف خلفي",
  "fuse": "فيوز",
  "wiring": "تمديدات كهربائية",

  // AC / cooling
  "ac service": "صيانة المكيف",
  "ac compressor": "كومبروسر المكيف",
  "ac gas refill": "تعبئة غاز المكيف",
  "ac filter": "فلتر المكيف",

  // Body / interior
  "wiper blades": "مساحات الزجاج",
  "wiper blade": "مساحة الزجاج",
  "windshield": "زجاج أمامي",
  "windshield repair": "إصلاح الزجاج الأمامي",

  // Diagnostic / service
  "diagnostics": "فحص كمبيوتر",
  "diagnosis": "تشخيص",
  "inspection": "فحص",
  "general service": "صيانة عامة",
  "tune up": "ضبط المحرك",

  // Charges — these are the most common 'always present' lines on
  // a UAE invoice and DEFINITELY need translating in Arabic-locale.
  "labor": "أجور العمالة",
  "labour": "أجور العمالة",
  "labor charges": "أجور العمالة",
  "labour charges": "أجور العمالة",
  "service fee": "رسوم الخدمة",
  "diagnostic fee": "رسوم الفحص",
  "call out fee": "رسوم استدعاء",
  "discount": "خصم",
};

/**
 * Translate a line-item description for display in the given locale.
 *
 * Locale === 'ar' → look up in DICTIONARY (normalized); return Arabic
 * if matched, else return the original description unchanged.
 *
 * Locale !== 'ar' → return the description unchanged. This is the
 * canonical form (cashier-entered, usually English) and we don't try
 * to back-translate Arabic strings into English.
 *
 * Never mutates the input; this is a pure render-time helper.
 */
export function translateLineDescription(
  description: string,
  locale: string,
): string {
  if (locale !== "ar") return description;
  if (!description) return description;
  const key = normalize(description);
  const hit = DICTIONARY[key];
  if (hit) return hit;
  // No exact match — fall back to the raw description so custom items
  // (e.g. 'WD-40 spray' or a part-number string) still appear.
  return description;
}

// Exported for tests so a future contributor can verify a row exists
// without re-reaching into the private map.
export function _hasTranslation(description: string): boolean {
  return DICTIONARY[normalize(description)] !== undefined;
}
