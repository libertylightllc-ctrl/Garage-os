import type { Browser } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { signId } from "@/lib/tokens";
import { appUrl } from "@/lib/whatsapp";

/**
 * Render a customer-facing invoice as a PDF using headless Chromium.
 *
 * The renderer hits our OWN public URL — `/c/invoice/<signed-token>` —
 * so the PDF is byte-for-byte the same layout the customer sees on
 * the page. This is the whole point of choosing Chromium over a
 * JSX-to-PDF library: one HTML template, one source of truth. When
 * we change the invoice layout, the PDF changes with it — no
 * parallel template to keep in sync.
 *
 * On Vercel (production) the Chromium binary is supplied by
 * @sparticuz/chromium — a stripped build that fits inside the
 * serverless function size cap. `executablePath()` returns a Linux
 * binary from the packed lambda layer.
 *
 * On local dev (Windows / macOS) @sparticuz/chromium's binary won't
 * launch. The helper falls back to the operator's installed
 * Chrome. Set LOCAL_CHROME_PATH to override; otherwise we probe the
 * standard install location. Not verifying locally is fine — the
 * important verification is against prod.
 *
 * Warm reuse: the browser instance is cached in module scope. Vercel
 * warm functions reuse it across requests, so we only pay the
 * ~2 s cold-start once per instance. If Chromium crashes / times out,
 * launch() throws → the caller returns 502 and the next call spawns
 * a fresh browser.
 */

let cachedBrowser: Browser | null = null;

async function resolveExecutablePath(): Promise<string | undefined> {
    // Explicit override wins — CI, one-off runs, docker.
    if (process.env.LOCAL_CHROME_PATH) return process.env.LOCAL_CHROME_PATH;

    // Vercel / Linux — packaged binary. `executablePath()` extracts
    // the tar on first call, caches under /tmp on subsequent ones.
    if (process.platform === "linux") {
        return await chromium.executablePath();
    }

    // Local dev on Windows or macOS — fall through to well-known
    // Chrome install paths. If not present, puppeteer will throw and
    // the caller will get a 502 they can debug from server logs.
    if (process.platform === "win32") {
        return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    }
    if (process.platform === "darwin") {
        return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    }
    return undefined;
}

async function getBrowser(): Promise<Browser> {
    if (cachedBrowser && cachedBrowser.connected) return cachedBrowser;

    const executablePath = await resolveExecutablePath();

    // @sparticuz/chromium's args are tuned for serverless: --no-sandbox,
    // --disable-gpu, single-process, etc. Safe to use locally too.
    // v149 dropped `defaultViewport`/`headless` from the exported class
    // — puppeteer defaults are fine (headless=true, sensible viewport).
    const browser = await puppeteer.launch({
        args: chromium.args,
        executablePath,
        headless: true,
    });
    cachedBrowser = browser;
    return browser;
}

/**
 * Render an invoice to A4 PDF bytes.
 *
 * `invoiceId` is the RAW DB id — this function signs it internally
 * so callers on both the public and staff sides pass the same input
 * shape. That also means the signing scheme change is a one-file
 * update, not a caller-by-caller sweep.
 *
 * Caller is responsible for garage-scoping the invoice lookup BEFORE
 * calling here. This function does no auth of its own — it just
 * renders. The public `/c/invoice/<token>/pdf` route relies on the
 * token verification for auth; the staff route uses requireAnyRole.
 */
export async function renderInvoicePdf(invoiceId: string): Promise<Buffer> {
    const token = signId("invoice", invoiceId);
    const url = `${appUrl()}/c/invoice/${token}`;

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        // networkidle0 waits until fewer than 0 network connections for
        // 500ms — the customer invoice loads its logo async, so this
        // ensures the logo lands before we snapshot. 20 s cap so a
        // hanging DB query can't tie up the whole function.
        await page.goto(url, {
            waitUntil: "networkidle0",
            timeout: 20_000,
        });
        // emulateMediaType('print') so the page uses its `print:` CSS
        // (which the existing invoice already carries — same layout
        // the operator gets when clicking Print). Without this, the
        // PDF captures the on-screen styles including nav chrome.
        await page.emulateMediaType("print");
        const bytes = await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: false,
            margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
        });
        // page.pdf() returns a Uint8Array on newer puppeteer versions;
        // normalise to Buffer so route handlers can hand it to NextResponse.
        return Buffer.from(bytes);
    } finally {
        await page.close();
    }
}
