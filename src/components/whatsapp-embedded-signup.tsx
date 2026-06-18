"use client";

import { useEffect, useRef, useState } from "react";

/**
  * Facebook Embedded Signup launcher for WhatsApp Business onboarding.
  *
  * What the SDK does (per Meta docs):
  *   1. Loads the FB JS SDK at runtime with the garage's App ID.
  *   2. Calls FB.login({ config_id, response_type: 'code', override_default_response_type: true })
  *      which pops the Embedded Signup flow — the customer (the garage owner)
  *      adds their WhatsApp Business number inside the popup.
  *   3. On success, returns a short-lived 'code'. We POST this code
  *      to /api/whatsapp/connect-callback which does the server-side
  *      code→token exchange (needs APP_SECRET — never expose client-side).
  *   4. The callback route writes the encrypted token onto
  *      WhatsAppAccount and redirects the page; this component just
  *      hands the code over.
  *
  * Client component because the FB SDK needs a real browser window and
  * the `FB.login` callback fires async. We never store the access
  * token in this component's state — it never leaves the server.
  *
  * Disabled when appId/configId are empty (production mode env vars
  * not set). The owner page already guards on this before rendering
  * us, so it's belt-and-braces.
  */

declare global {
    interface Window {
        FB?: {
            init: (opts: { appId: string; cookie?: boolean; xfbml?: boolean; version: string }) => void;
            login: (
                callback: (resp: { authResponse?: { code?: string }; status: string }) => void,
                opts: {
                    config_id: string;
                    response_type: "code";
                    override_default_response_type: boolean;
                },
            ) => void;
        };
        fbAsyncInit?: () => void;
    }
}

export function EmbeddedSignupButton({
    appId,
    configId,
    connectLabel,
}: {
    appId: string;
    configId: string;
    connectLabel: string;
}) {
    const [ready, setReady] = useState(false);
    const [status, setStatus] = useState<"idle" | "exchanging" | "error">("idle");
    const triggeredRef = useRef(false);

    useEffect(() => {
        if (!appId || !configId) return;
        if (typeof window === "undefined") return;
        // Load the SDK only once per page lifetime.
        if (document.getElementById("fb-sdk")) {
            setReady(!!window.FB);
            return;
        }
        window.fbAsyncInit = () => {
            window.FB?.init({
                appId,
                cookie: true,
                xfbml: false,
                version: "v20.0",
            });
            setReady(true);
        };
        const script = document.createElement("script");
        script.id = "fb-sdk";
        script.async = true;
        script.defer = true;
        script.crossOrigin = "anonymous";
        script.src = "https://connect.facebook.net/en_US/sdk.js";
        document.body.appendChild(script);
    }, [appId, configId]);

    const launch = () => {
        if (!ready || !window.FB || triggeredRef.current) return;
        triggeredRef.current = true;
        window.FB.login(
            (resp) => {
                triggeredRef.current = false;
                const code = resp?.authResponse?.code;
                if (!code) {
                    // User dismissed the popup or denied permissions. Reset
                    // and let them try again.
                    setStatus("idle");
                    return;
                }
                setStatus("exchanging");
                // Server-side exchange: POST the code to the callback route,
                // which does code→token via Meta's Graph API using APP_SECRET
                // (never available client-side). The route writes
                // WhatsAppAccount and reloads.
                fetch("/api/whatsapp/connect-callback", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code }),
                })
                    .then((r) => {
                        if (!r.ok) throw new Error(`Exchange failed (${r.status})`);
                        // Reload so the owner page re-renders with the new
                        // connected state (server reads WhatsAppAccount).
                        window.location.reload();
                    })
                    .catch(() => setStatus("error"));
            },
            {
                config_id: configId,
                response_type: "code",
                override_default_response_type: true,
            },
        );
    };

    return (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                disabled={!ready || status === "exchanging" || !appId || !configId}
                onClick={launch}
                className="rounded-md bg-success-500 px-4 py-2 text-sm font-semibold text-white hover:bg-success-500/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {status === "exchanging" ? "Connecting…" : connectLabel}
            </button>
            {status === "error" ? (
                <p className="text-xs text-danger-700">
                    Connection failed. Check the Meta App Secret env var and try
                    again.
                </p>
            ) : null}
        </div>
    );
}
