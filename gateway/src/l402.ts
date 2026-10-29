import crypto from "crypto";

const ROOT_SECRET =
  process.env.L402_SECRET || "volt402-super-secret-hackathon-root-key-2026";

export interface MacaroonPayload {
  identifier: string; // Commits to payment_hash and token nonce
  caveats: string[]; // e.g., ["bay_id=1", "allocated_kwh=30", "tier=DC_FAST_120KW"]
  signature: string; // Chained HMAC-SHA256 hex signature
}

function hmacSha256(key: Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Mints a chained HMAC-SHA256 Macaroon bound to a Lightning payment_hash
 * and generates a simulated BOLT11 invoice + preimage pair for the PoC.
 */
export function createL402Challenge(
  bayId: number,
  allocatedKwh: number,
  amountSats: number,
  tier: string,
) {
  // 1. Generate 32-byte Lightning preimage (r) and payment_hash H = SHA256(r)
  const preimageBytes = crypto.randomBytes(32);
  const preimageHex = preimageBytes.toString("hex");
  const paymentHashHex = crypto
    .createHash("sha256")
    .update(preimageBytes)
    .digest("hex");

  // 2. Construct Macaroon Identifier & Caveats
  const identifier = `v402:${paymentHashHex}:${Date.now()}`;
  const caveats = [
    `bay_id=${bayId}`,
    `allocated_kwh=${allocatedKwh}`,
    `tier=${tier}`,
    `amount_sats=${amountSats}`,
    `expires=${Date.now() + 3600_000}`,
  ];

  // 3. Compute Chained HMAC-SHA256 Signature
  let sig = hmacSha256(Buffer.from(ROOT_SECRET, "utf8"), identifier);
  for (const caveat of caveats) {
    sig = hmacSha256(sig, caveat);
  }

  const macaroonObj: MacaroonPayload = {
    identifier,
    caveats,
    signature: sig.toString("hex"),
  };

  const macaroonBase64 = Buffer.from(
    JSON.stringify(macaroonObj),
    "utf8",
  ).toString("base64");

  // 4. Construct BOLT11-formatted Invoice String
  const mockBolt11 = `lnbc${amountSats}0n1pvolt402pp5${paymentHashHex.slice(0, 24)}qdqqxqyjw5qcqpjsp5`;

  return {
    macaroonBase64,
    invoice: mockBolt11,
    paymentHashHex,
    demoPreimageHex: preimageHex, // Included in JSON body for 1-click stage simulation
    caveats,
  };
}

/**
 * Statelessly verifies `Authorization: L402 <macaroonBase64>:<preimageHex>`
 */
export function verifyL402Credential(
  macaroonBase64: string,
  preimageHex: string,
  expectedBayId: number,
): {
  valid: boolean;
  reason?: string;
  allocatedKwh?: number;
  paymentHash?: string;
} {
  try {
    const decodedJson = Buffer.from(macaroonBase64, "base64").toString("utf8");
    const macaroon: MacaroonPayload = JSON.parse(decodedJson);

    // 1. Extract committed payment_hash from identifier ("v402:<hash>:<timestamp>")
    const parts = macaroon.identifier.split(":");
    if (parts.length !== 3 || parts[0] !== "v402") {
      return { valid: false, reason: "Malformed Macaroon identifier" };
    }
    const committedHash = parts[1];

    // 2. Verify SHA256(preimage) === committedHash
    const preimageBuf = Buffer.from(preimageHex, "hex");
    if (preimageBuf.length !== 32) {
      return {
        valid: false,
        reason: "Preimage must be 32 bytes (64 hex chars)",
      };
    }
    const computedHash = crypto
      .createHash("sha256")
      .update(preimageBuf)
      .digest("hex");
    if (computedHash !== committedHash) {
      return {
        valid: false,
        reason: "Cryptographic mismatch: SHA256(preimage) != payment_hash",
      };
    }

    // 3. Recompute Chained HMAC-SHA256 across all caveats
    let sig = hmacSha256(Buffer.from(ROOT_SECRET, "utf8"), macaroon.identifier);
    for (const caveat of macaroon.caveats) {
      sig = hmacSha256(sig, caveat);
    }
    if (sig.toString("hex") !== macaroon.signature) {
      return { valid: false, reason: "Invalid Macaroon HMAC chain signature" };
    }

    // 4. Enforce Caveats (bay_id, allocated_kwh, expiration)
    const caveatMap = new Map<string, string>();
    for (const c of macaroon.caveats) {
      const [k, v] = c.split("=");
      if (k && v) caveatMap.set(k, v);
    }

    if (Number(caveatMap.get("bay_id")) !== expectedBayId) {
      return {
        valid: false,
        reason: `Caveat violation: token locked to bay ${caveatMap.get("bay_id")}`,
      };
    }

    const expires = Number(caveatMap.get("expires") || 0);
    if (Date.now() > expires) {
      return { valid: false, reason: "Caveat violation: Macaroon expired" };
    }

    const allocatedKwh = Number(caveatMap.get("allocated_kwh") || 15);
    return { valid: true, allocatedKwh, paymentHash: committedHash };
  } catch (err) {
    return { valid: false, reason: "Failed to parse L402 credential" };
  }
}
