import type { MetadataRoute } from "next";

// AR 2026-08-26 — SEO foundation, Batch A. Explicit allow-list for
// the public marketing surfaces; disallow every authenticated /
// signed-token / operator route. Belt-and-braces with the per-route
// noindex on /c/estimate and /c/invoice (a379dd1) — those already
// send X-Robots-Tag + meta robots noindex; the disallow here keeps
// well-behaved crawlers from even fetching them.
//
// If a future public marketing route is added (blog, /pricing,
// /features, etc.), add its path to `allow` explicitly.

export default function robots(): MetadataRoute.Robots {
    return {
        rules: [
            {
                userAgent: "*",
                allow: ["/", "/login"],
                disallow: [
                    "/c/",
                    "/api/",
                    "/admin/",
                    "/owner/",
                    "/advisor/",
                    "/cashier/",
                    "/tech/",
                    "/master/",
                    "/settings",
                    "/estimates/",
                    "/invoices/",
                    "/account/",
                ],
            },
        ],
        sitemap: "https://www.garageos.shop/sitemap.xml",
    };
}
