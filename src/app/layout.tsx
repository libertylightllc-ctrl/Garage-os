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
  title:"Garage OS",
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
      <body className="min-h-full flex flex-col">
        <LangSwitcher locale={locale} />
        {children}
      </body>
    </html>
  );
}
