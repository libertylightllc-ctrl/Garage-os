import type { MetadataRoute } from "next";

// AR 2026-08-26 — SEO foundation, Batch A. One entry for the
// marketing home. Deliberately short: the only page we currently
// publish and want crawled. Additional public routes (blog, feature
// pages) added here as they land.
//
// Per-garage booking URLs (/c/book/[garageId]) are NOT sitemap'd
// unless AR explicitly enables indexing on them (Q2 in the SEO
// batch). Garage IDs are cuid — cryptographically unguessable — so
// enumeration isn't a risk, but a sitemap containing them would be
// a deliberate disclosure of which shops use us. The public
// marketing home would be the right place to link to shop bookings
// individually if / when we want that.

const BASE = "https://www.garageos.shop";

export default function sitemap(): MetadataRoute.Sitemap {
    return [
        {
            url: `${BASE}/`,
            lastModified: new Date("2026-08-26"),
            changeFrequency: "monthly",
            priority: 1,
        },
    ];
}
