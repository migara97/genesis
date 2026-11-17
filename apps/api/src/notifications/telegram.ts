import { readSecret } from "../secrets/store.js";

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/** Send a Telegram Bot API message. Uses encrypted secrets only. */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const token = readSecret("TELEGRAM_BOT_TOKEN");
  const chatId = readSecret("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!res.ok || !body.ok) {
      return {
        ok: false,
        error: body.description ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
