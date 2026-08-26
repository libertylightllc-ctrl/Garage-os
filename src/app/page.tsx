import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { roleHome } from "@/lib/roles";
import { MarketingHome } from "@/components/marketing/marketing-home";

// Root entry. Logged-in staff are dispatched to their role home exactly
// as before (the 4 live shops' entry point is unchanged). Anonymous
// visitors — who previously bounced straight to /login — now see the
// public marketing homepage; /login stays reachable via its "Sign in"
// links, so no existing app route or auth flow changes. Purely additive.

// AR 2026-08-26 — SEO foundation, Batch A. JSON-LD on the marketing
// home so Google understands what GarageOS is (SoftwareApplication +
// Organization), what it costs (offers), and where to find us. The
// script tag is inline in RSC output; no client bundle cost.
const homeJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.garageos.shop/#organization",
      name: "GarageOS",
      url: "https://www.garageos.shop/",
      description:
        "AI-first garage operating system for the GCC. WhatsApp-first intake, VAT-ready invoicing, Arabic + English.",
      areaServed: [
        { "@type": "Country", name: "United Arab Emirates" },
      ],
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.garageos.shop/#software",
      name: "GarageOS",
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "Auto Repair Shop Management",
      operatingSystem: "Web, iOS, Android",
      description:
        "Workshop operating system for UAE and GCC garages. Runs the whole flow from WhatsApp intake through job card, estimate, approval, repair, and signed tax invoice. AI proposes, humans confirm.",
      inLanguage: ["en", "ar"],
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "AED",
        availability: "https://schema.org/InStock",
        description: "Free during pilot; per-branch subscription after.",
      },
      publisher: {
        "@id": "https://www.garageos.shop/#organization",
      },
    },
    {
      "@type": "WebSite",
      "@id": "https://www.garageos.shop/#website",
      url: "https://www.garageos.shop/",
      name: "GarageOS",
      publisher: {
        "@id": "https://www.garageos.shop/#organization",
      },
      inLanguage: ["en", "ar"],
    },
  ],
};

export default async function Index() {
  const session = await auth();
  if (session?.user) redirect(roleHome(session.user.role));
  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD payload is trusted, hand-authored above; no user
        // input flows into it. dangerouslySetInnerHTML is the
        // documented way to inject this on RSC.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(homeJsonLd) }}
      />
      <MarketingHome />
    </>
  );
}
