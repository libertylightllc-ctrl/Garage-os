import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import"./globals.css";
import { getLocale } from "@/i18n/server";
import { isRtl } from "@/i18n/config";
import { LangSwitcher } from "@/components/lang-switcher";

const geistSans = Geist({
  variable:"--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable:"--font-geist-mono",
  subsets: ["latin"],
});

// AR 2026-08-26 — SEO foundation, Batch A. Discoverable for
// "garage software UAE"-shaped queries. metadataBase resolves the
// relative asset paths below (opengraph-image, twitter-image) at
// build time so the tags carry absolute URLs.
export const metadata: Metadata = {
  metadataBase: new URL("https://www.garageos.shop"),
  title: {
    default: "GarageOS — AI-first garage operating system for the GCC",
    template: "%s · GarageOS",
  },
  description:
    "GarageOS runs your workshop from WhatsApp intake to signed invoice. AI proposes, humans confirm. Built for UAE and GCC garages — Arabic + English, VAT-ready, no training needed.",
  applicationName: "GarageOS",
  keywords: [
    "garage software",
    "garage management",
    "auto workshop software",
    "UAE garage software",
    "GCC garage software",
    "workshop management",
    "WhatsApp garage",
    "car repair software",
    "vehicle service software",
    "auto repair app",
    "garage app UAE",
    "workshop app",
  ],
  authors: [{ name: "GarageOS" }],
  category: "productivity",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "https://www.garageos.shop/",
    siteName: "GarageOS",
    title: "GarageOS — AI-first garage operating system for the GCC",
    description:
      "Run your workshop from WhatsApp intake to signed invoice. AI proposes, humans confirm. Arabic + English, UAE VAT built in.",
    locale: "en_AE",
    // The opengraph-image at src/app/opengraph-image.tsx is generated
    // dynamically at request time and picked up automatically — no
    // need to list it here.
  },
  twitter: {
    card: "summary_large_image",
    title: "GarageOS — AI-first garage operating system for the GCC",
    description:
      "Run your workshop from WhatsApp intake to signed invoice. Built for UAE + GCC garages.",
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      dir={isRtl(locale) ?"rtl":"ltr"}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*  Shell reservations (220px inline-start on md+, bottom-bar
           clearance on mobile) live in globals.css keyed on the shell's
           own DOM markers — `body:has([data-app-shell])` and
           `body:has([data-mobile-tab-bar])`. That way public + login +
           customer pages (which don't render the shell) stay centred
           and don't reserve space for a bar or side nav that isn't
           there. See src/app/globals.css. */}
      <body className="min-h-full flex flex-col">
        <LangSwitcher locale={locale} />
        {children}
      </body>
    </html>
  );
}
