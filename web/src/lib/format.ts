/** MonadVision, the block explorer for Monad testnet. */
export const EXPLORER = "https://testnet.monadvision.com";

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;

export const short = (hex: string, head = 6, tail = 4) => `${hex.slice(0, head)}…${hex.slice(-tail)}`;

/** Offers are integers in US cents per 1,000 API calls. */
export const dollars = (cents: string | bigint) => {
  const n = Number(cents);
  return `$${(n / 100).toFixed(2)}`;
};

export const STANCE_LABEL: Record<string, string> = {
  "open-with-room": "opens with room",
  concede: "concedes",
  hold: "holds",
  "final-at-limit": "goes to its limit",
};

/** A unix deadline in seconds as "2026-09-27 17:25 UTC". */
export const utc = (seconds: string) =>
  new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** "Demo: price per 1,000 calls …, in US cents" as "Price per 1,000 calls …". */
export const terms = (raw: string) => {
  const text = raw.replace(/^Demo:\s*/, "").replace(/,\s*in US cents$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Explanations are written by code in cents; the page shows dollars. Same numbers, one unit. */
export const inDollars = (text: string) => text.replace(/\b\d{2,}\b/g, (n) => dollars(n));

export const pad2 = (n: number) => String(n).padStart(2, "0");
