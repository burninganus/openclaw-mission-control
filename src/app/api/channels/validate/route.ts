import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/validate
 *
 * Validates a channel token before saving it to config.
 * Telegram: calls https://api.telegram.org/bot{token}/getMe
 * Discord: calls https://discord.com/api/v10/users/@me
 *
 * Returns { ok: true, botName: "..." } on success.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const channel = body.channel as string;
    const token = (body.token as string || "").trim();

    if (!channel || !token) {
      return NextResponse.json({ error: "channel and token are required" }, { status: 400 });
    }

    if (channel === "telegram") {
      // Basic format check: Telegram tokens look like 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
      if (!/^\d+:[A-Za-z0-9_\-/+=]+$/.test(token)) {
        return NextResponse.json({
          ok: false,
          error: "That doesn\u2019t look like a Telegram bot token. It should start with numbers, then a colon, like 123456789:ABCdef... \u2014 you can get one by messaging @BotFather in Telegram.",
        });
      }

      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return NextResponse.json({
          ok: false,
          error: (body as Record<string, string>).description || `Telegram API returned ${res.status}. Check your bot token.`,
        });
      }
      const data = await res.json();
      if (!data.ok || !data.result) {
        return NextResponse.json({
          ok: false,
          error: data.description || "This token was rejected by Telegram. Open Telegram, message @BotFather, and use /mybots to find or regenerate your token.",
        });
      }
      return NextResponse.json({
        ok: true,
        botName: data.result.first_name || data.result.username,
        botUsername: data.result.username,
      });
    }

    if (channel === "discord") {
      const res = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return NextResponse.json({
          ok: false,
          error: (data as Record<string, string>).message || "This token was rejected by Discord. Go to the Discord Developer Portal \u2192 your app \u2192 Bot section and copy the token.",
        });
      }
      const data = await res.json();
      return NextResponse.json({
        ok: true,
        botName: data.username || "Discord Bot",
        botUsername: data.username,
      });
    }

    // Unsupported channel — skip validation
    return NextResponse.json({ ok: true, botName: null });
  } catch (err) {
    console.error("Channel validate error:", err);
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const isNetwork = err instanceof TypeError && err.message.includes("fetch");
    return NextResponse.json({
      ok: false,
      error: isTimeout
        ? "The request timed out. The service might be temporarily unavailable \u2014 please try again in a moment."
        : isNetwork
          ? "Could not reach the service. Check your internet connection and try again."
          : "Something went wrong while checking your token. Please try again.",
    }, { status: 500 });
  }
}
