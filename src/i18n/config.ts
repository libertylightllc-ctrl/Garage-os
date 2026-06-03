export const locales = ["en", "ar"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function isRtl(locale: Locale): boolean {
  return locale === "ar";
}

// Phase-1 dictionary. Infra supports full coverage; key customer-facing + auth
// screens are translated here, the rest fill in against these keys.
export const messages = {
  en: {
    signInTitle: "Staff sign in",
    email: "Email",
    password: "Password",
    signIn: "Sign in",
    demoTitle: "Demo logins (password: password)",
    invalid: "Invalid email or password.",

    bookTitle: "Book a service",
    bookIntro: "Tell us what’s wrong in your own words — we’ll propose a fix.",
    name: "Your name",
    phone: "Phone",
    make: "Make",
    model: "Model",
    plate: "Plate",
    describe: "Describe the problem (e.g. ‘AC not cooling when hot’)",
    optionalPhoto: "Optional photo",
    getProposal: "Get a proposal",
  },
  ar: {
    signInTitle: "تسجيل دخول الموظفين",
    email: "البريد الإلكتروني",
    password: "كلمة المرور",
    signIn: "تسجيل الدخول",
    demoTitle: "حسابات تجريبية (كلمة المرور: password)",
    invalid: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",

    bookTitle: "احجز خدمة",
    bookIntro: "أخبرنا بالمشكلة بكلماتك — وسنقترح الحل.",
    name: "الاسم",
    phone: "الهاتف",
    make: "الماركة",
    model: "الموديل",
    plate: "اللوحة",
    describe: "صف المشكلة بكلماتك (مثال: المكيّف لا يبرّد عند الحرارة)",
    optionalPhoto: "صورة اختيارية",
    getProposal: "احصل على اقتراح",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];
