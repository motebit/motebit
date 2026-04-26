/**
 * `motebit balance` / `motebit withdraw` / `motebit fund` — the
 * user-facing money path. Talks to the relay's virtual account
 * ledger (balance + transaction history), submits withdrawal
 * requests, and opens Stripe Checkout for deposits.
 *
 * `handleFund` is the most involved: it opens Checkout in the user's
 * browser via `open`/`xdg-open`, then polls the balance endpoint
 * (via the private `getBalanceAmount` helper) for up to two minutes
 * waiting for the Stripe webhook to credit the account.
 */

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { formatTimeAgo } from "../utils.js";
import { fetchRelayJson, getRelayUrl, getRelayAuthHeaders, requireMotebitId } from "./_helpers.js";

export async function handleBalance(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());

  const relayUrl = getRelayUrl(config);
  // Aud must match the relay's `dualAuth` binding for /balance.
  // See `services/api/src/middleware.ts:631` — `account:balance`.
  // Default `admin:query` is rejected by the agents-virtual-account
  // routes; each money-path subcommand pins its own aud.
  const headers = await getRelayAuthHeaders(config, { aud: "account:balance" });

  const result = await fetchRelayJson(`${relayUrl}/api/v1/agents/${motebitId}/balance`, headers);
  if (!result.ok) {
    console.error(`Failed to get balance: ${result.error}`);
    process.exit(1);
  }

  const data = result.data as {
    balance: number;
    currency: string;
    transactions: Array<{
      type: string;
      amount: number;
      created_at: string;
    }>;
  };

  if (config.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\nBalance: $${data.balance.toFixed(2)} ${data.currency}`);
  const recent = (data.transactions ?? []).slice(0, 5);
  if (recent.length > 0) {
    console.log("Recent:");
    for (const tx of recent) {
      const sign = tx.amount >= 0 ? "+" : "";
      const ago = formatTimeAgo(Date.now() - new Date(tx.created_at).getTime());
      console.log(`  ${sign}$${Math.abs(tx.amount).toFixed(2)}  ${tx.type.padEnd(20)} ${ago}`);
    }
  }
  console.log();
}

export async function handleWithdraw(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());

  const amountStr = config.positionals[1];
  if (!amountStr) {
    console.error("Usage: motebit withdraw <amount> [--destination <addr>]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error("Error: amount must be a positive number.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  // `account:withdraw` matches `services/api/src/middleware.ts:635`.
  const headers = await getRelayAuthHeaders(config, { aud: "account:withdraw", json: true });

  const body: Record<string, unknown> = { amount };
  if (config.destination) body["destination"] = config.destination;

  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    if (res.status === 402) {
      console.error("Insufficient balance.");
      process.exit(1);
    }
    if (!res.ok) {
      const text = await res.text();
      console.error(`Withdrawal failed (${res.status}): ${text.slice(0, 200)}`);
      process.exit(1);
    }
    const data = (await res.json()) as { withdrawal_id?: string };
    console.log(`Withdrawal of $${amount.toFixed(2)} submitted.`);
    if (data.withdrawal_id != null && data.withdrawal_id !== "") {
      console.log(`  ID: ${data.withdrawal_id}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay: ${msg}`);
    process.exit(1);
  }
}

export async function handleFund(config: CliConfig): Promise<void> {
  const motebitId = requireMotebitId(loadFullConfig());

  const amountStr = config.positionals[1];
  if (!amountStr) {
    console.error("Usage: motebit fund <amount>");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount < 0.5) {
    console.error("Error: minimum amount is $0.50.");
    process.exit(1);
  }

  const relayUrl = getRelayUrl(config);
  // Two distinct relay routes are exercised here. Each is bound to its
  // own audience by `services/api/src/middleware.ts:631 / :643`:
  //   POST /checkout → account:checkout
  //   GET  /balance  → account:balance
  // A single signed token can only carry one aud, so we mint two.
  const checkoutHeaders = await getRelayAuthHeaders(config, {
    aud: "account:checkout",
    json: true,
  });
  const balanceHeaders = await getRelayAuthHeaders(config, { aud: "account:balance" });

  // Create Stripe Checkout session
  let checkoutUrl: string;
  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/checkout`, {
      method: "POST",
      headers: checkoutHeaders,
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      // Surface the structured error the relay's mapStripeError emits
      // (`{ error, message, stripe_type, stripe_code }`) when the
      // failure comes from the Stripe API itself. Falls back to raw
      // text for older relay deployments that haven't shipped the
      // structured-error commit yet.
      let body: unknown;
      const rawText = await res.text();
      try {
        body = JSON.parse(rawText);
      } catch {
        body = null;
      }
      if (body !== null && typeof body === "object" && "error" in body) {
        const e = body as { error: string; message?: string; stripe_code?: string | null };
        console.error(`Checkout failed (${res.status}): ${e.error}`);
        if (e.message) console.error(`  ${e.message}`);
        if (e.error === "STRIPE_ACCOUNT_NOT_ACTIVATED") {
          console.error(
            "  → Complete the past-due task at https://dashboard.stripe.com/account/onboarding",
          );
        }
      } else {
        console.error(`Checkout failed (${res.status}): ${rawText.slice(0, 200)}`);
      }
      process.exit(1);
    }
    const data = (await res.json()) as { checkout_url: string; session_id: string };
    checkoutUrl = data.checkout_url;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay: ${msg}`);
    process.exit(1);
  }

  // Open in browser
  console.log(`\nOpening Stripe Checkout for $${amount.toFixed(2)}...\n`);
  console.log(`  ${checkoutUrl}\n`);
  try {
    const { execSync } = await import("node:child_process");
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${openCmd} "${checkoutUrl}"`, { stdio: "ignore" });
  } catch {
    console.log("Could not open browser. Please visit the URL above to complete payment.");
  }

  // Poll for deposit confirmation (120s max, 3s intervals)
  console.log("Waiting for payment confirmation...");
  const startBalance = await getBalanceAmount(relayUrl, motebitId, balanceHeaders);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    const currentBalance = await getBalanceAmount(relayUrl, motebitId, balanceHeaders);
    if (currentBalance !== null && startBalance !== null && currentBalance > startBalance) {
      console.log(`\nDeposit confirmed! Balance: $${currentBalance.toFixed(2)}`);
      return;
    }
    process.stdout.write(".");
  }
  console.log("\nPayment not yet confirmed. Check `motebit balance` after completing checkout.");
}

async function getBalanceAmount(
  relayUrl: string,
  motebitId: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/balance`, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { balance: number };
    return data.balance;
  } catch {
    return null;
  }
}
