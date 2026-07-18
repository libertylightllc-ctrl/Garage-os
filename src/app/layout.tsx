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

export const metadata: Metadata = {
  title:"Garage Os",
  description:"The garage operating system where AI does the thinking and the human decides.",
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
