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
      {/*  Bottom padding on mobile clears the fixed bottom tab bar
           (BottomTabBar min-h [56px] + safe-area-inset-bottom, up to
           ~34px on iOS with a home indicator). Without this the last
           row of any list — most visibly the cashier Receivables
           list — sits under the bar and its "Mark as Paid" action
           can't be tapped. Zero effect on md+ where the bottom bar
           is hidden. */}
      <body className="min-h-full flex flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0 md:ps-[220px]">
        <LangSwitcher locale={locale} />
        {children}
      </body>
    </html>
  );
}
