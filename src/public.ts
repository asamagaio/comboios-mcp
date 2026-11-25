/** Settings of the public (hosted) deployment. */
import { CpError } from "./errors.js";

export function paymentsEnabled(): boolean {
  return process.env.PAYMENTS_ENABLED === "1";
}

export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  throw new CpError("CONFIG_INVALID", "PUBLIC_BASE_URL is not set");
}

/** Link to our purchase page for an option id from horarios. */
export function buyUrl(optionId: string): string {
  return `${publicBaseUrl()}/comprar?o=${encodeURIComponent(optionId)}`;
}
