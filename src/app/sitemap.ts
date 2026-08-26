import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";

// AR 2026-08-26 — SEO foundation, Batch A. Marketing home + every
// live garage's public booking page. AR's call: cuid IDs make
// enumeration a non-risk, the booking page shows only the shop
// name and a form, and a customer finding their shop through search
// is a genuine benefit. The sitemap is the discovery path — Google
// won't crawl a URL it can't reach.
//
// Disclosure trade-off (worth naming): this reveals to anyone
// reading the sitemap which shops are on GarageOS. Each shop's
// garage.name is already public on its own booking page and every
// invoice it sends, so the added leak is a shop-count and a
// per-shop URL. If a specific shop ever wants to opt out of
// discoverability, add a `Garage.publicBookingEnabled` flag and
// filter here.

const BASE = "https://www.garageos.shop";

export const revalidate = 3600; // rebuild sitemap hourly

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const garages = await prisma.garage.findMany({
        select: { id: true, updatedAt: true },
        orderBy: { createdAt: "asc" },
    });

    return [
        {
            url: `${BASE}/`,
            lastModified: new Date("2026-08-26"),
            changeFrequency: "monthly",
            priority: 1,
        },
        ...garages.map((g) => ({
            url: `${BASE}/c/book/${g.id}`,
            lastModified: g.updatedAt,
            changeFrequency: "weekly" as const,
            priority: 0.8,
        })),
    ];
}
