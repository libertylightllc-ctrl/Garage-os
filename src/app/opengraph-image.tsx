import { ImageResponse } from "next/og";

// AR 2026-08-26 — SEO foundation, Batch A. Next's file-based OG
// image at the root generates a 1200×630 PNG whenever Facebook /
// Twitter / WhatsApp / Slack fetch the site's og:image. No design
// file needed — the ImageResponse renderer draws directly from JSX
// server-side. Update when a real brand mark lands.
//
// Deliberately minimal: brand name + tagline + region. Any richer
// composition (logo, screenshot, gradient) belongs in a real design
// pass, not a foundation batch.

export const runtime = "edge";
export const alt = "GarageOS — AI-first garage operating system for the GCC";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
    return new ImageResponse(
        (
            <div
                style={{
                    height: "100%",
                    width: "100%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    backgroundColor: "#0f172a",
                    backgroundImage:
                        "radial-gradient(circle at 20% 20%, #1e293b 0%, #0f172a 60%)",
                    padding: "80px",
                    color: "#f8fafc",
                    fontFamily: "sans-serif",
                }}
            >
                <div style={{ fontSize: 40, letterSpacing: "-0.02em", opacity: 0.7 }}>
                    GarageOS
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div
                        style={{
                            fontSize: 84,
                            lineHeight: 1.05,
                            fontWeight: 700,
                            letterSpacing: "-0.03em",
                            maxWidth: 900,
                        }}
                    >
                        The garage operating system.
                    </div>
                    <div style={{ fontSize: 36, opacity: 0.8, maxWidth: 900 }}>
                        WhatsApp intake to signed invoice. AI proposes, humans decide.
                    </div>
                </div>
                <div
                    style={{
                        display: "flex",
                        gap: 32,
                        fontSize: 24,
                        opacity: 0.7,
                    }}
                >
                    <span>UAE + GCC</span>
                    <span>·</span>
                    <span>Arabic + English</span>
                    <span>·</span>
                    <span>VAT-ready</span>
                </div>
            </div>
        ),
        {
            ...size,
        },
    );
}
