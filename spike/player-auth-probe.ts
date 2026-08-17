/**
 * M1 probe: how does the plain Messages API (@anthropic-ai/sdk) authenticate
 * in this container, which has no ANTHROPIC_API_KEY anywhere?
 *
 * Finding so far: a placeholder x-api-key gets 401 — so if the container
 * injects credentials in transit, our own header is overriding it. This
 * probe strips the x-api-key header entirely and tries direct vs. proxied.
 *
 * Run: npx tsx spike/player-auth-probe.ts            (direct, no header)
 *      NODE_USE_ENV_PROXY=1 npx tsx spike/...        (via HTTPS_PROXY)
 */
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "placeholder-proxy-injected",
  // Null removes the header so an in-transit credential injector can win.
  defaultHeaders: process.env.ANTHROPIC_API_KEY ? {} : { "x-api-key": null },
});

async function main() {
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      messages: [{ role: "user", content: 'Reply with the single word "OK".' }],
    });
    const text = msg.content.find((b) => b.type === "text");
    console.log(`SUCCESS: ${text && "text" in text ? text.text : "(no text)"}`);
    console.log(`usage: ${JSON.stringify(msg.usage)}`);
  } catch (e: any) {
    console.log(`FAILED: ${e.status ?? ""} ${String(e).slice(0, 300)}`);
  }
}
main();
