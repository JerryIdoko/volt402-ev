import cors from "cors";
import express from "express";
import { createL402Challenge, verifyL402Credential } from "./l402";

const app = express();
app.use(
  cors({
    exposedHeaders: ["WWW-Authenticate"],
  }),
);
app.use(express.json());

export interface EvChargingBay {
  bayId: number;
  name: string;
  tier: "DC_FAST_120KW" | "AC_LEVEL2_22KW" | "EMOBILITY_3KW";
  connector: string;
  maxPowerKw: number;
  voltageV: number;
  status: "IDLE" | "AWAITING_L402" | "CHARGING" | "COMPLETED";
  authMode: "HUMAN_QR" | "M2M_AUTONOMOUS" | null;
  vehicleModel: string;
  batteryCapacityKwh: number;
  vehicleSocPercent: number;
  allocatedKwh: number;
  deliveredKwh: number;
  currentDrawKw: number;
  lastPaymentHash: string | null;
}

interface StationState {
  solarIrradianceKw: number;
  bessSocPercent: number;
  baseRateSatsPerKwh: number;
  bays: EvChargingBay[];
}

const state: StationState = {
  solarIrradianceKw: 85,
  bessSocPercent: 82,
  baseRateSatsPerKwh: 150,
  bays: [
    {
      bayId: 1,
      name: "Bay 01 • Supercharger DC",
      tier: "DC_FAST_120KW",
      connector: "CCS2 (800V DC)",
      maxPowerKw: 100,
      voltageV: 800,
      status: "IDLE",
      authMode: null,
      vehicleModel: "Hyundai Ioniq 5",
      batteryCapacityKwh: 77,
      vehicleSocPercent: 28,
      allocatedKwh: 0,
      deliveredKwh: 0,
      currentDrawKw: 0,
      lastPaymentHash: null,
    },
    {
      bayId: 2,
      name: "Bay 02 • Autonomous Fleet DC",
      tier: "DC_FAST_120KW",
      connector: "NACS (800V DC)",
      maxPowerKw: 120,
      voltageV: 800,
      status: "IDLE",
      authMode: null,
      vehicleModel: "Autonomous Robo-Van",
      batteryCapacityKwh: 100,
      vehicleSocPercent: 22,
      allocatedKwh: 0,
      deliveredKwh: 0,
      currentDrawKw: 0,
      lastPaymentHash: null,
    },
    {
      bayId: 3,
      name: "Bay 03 • Fast AC Fleet",
      tier: "AC_LEVEL2_22KW",
      connector: "Type 2 (415V 3-Phase)",
      maxPowerKw: 22,
      voltageV: 415,
      status: "IDLE",
      authMode: null,
      vehicleModel: "Rivian Delivery EDV",
      batteryCapacityKwh: 70,
      vehicleSocPercent: 45,
      allocatedKwh: 0,
      deliveredKwh: 0,
      currentDrawKw: 0,
      lastPaymentHash: null,
    },
    {
      bayId: 4,
      name: "Bay 04 • Commuter AC",
      tier: "AC_LEVEL2_22KW",
      connector: "Type 2 (415V 3-Phase)",
      maxPowerKw: 22,
      voltageV: 415,
      status: "IDLE",
      authMode: null,
      vehicleModel: "BYD Dolphin EV",
      batteryCapacityKwh: 60,
      vehicleSocPercent: 35,
      allocatedKwh: 0,
      deliveredKwh: 0,
      currentDrawKw: 0,
      lastPaymentHash: null,
    },
    {
      bayId: 5,
      name: "Bay 05 • E-Moto Dock A",
      tier: "EMOBILITY_3KW",
      connector: "72V DC Smart Plug",
      maxPowerKw: 3.3,
      voltageV: 72,
      status: "IDLE",
      authMode: null,
      vehicleModel: "Spiro Electric Moto",
      batteryCapacityKwh: 4.5,
      vehicleSocPercent: 18,
      allocatedKwh: 0,
      deliveredKwh: 0,
      currentDrawKw: 0,
      lastPaymentHash: null,
    },
    {
      bayId: 6,
      name: "Bay 06 • E-Cargo Keke Dock",
      tier: "EMOBILITY_3KW",
      connector: "72V DC Smart Plug",
      maxPowerKw: 3.3,
      voltageV: 72,
      status: "IDLE",
      authMode: null,
      vehicleModel: "Solar Electric Tricycle",
      batteryCapacityKwh: 7.2,
      vehicleSocPercent: 25,
      allocatedKwh: 0,
      deliveredKwh: 0,
      currentDrawKw: 0,
      lastPaymentHash: null,
    },
  ],
};

function getActiveLoadKw(): number {
  return Number(
    state.bays
      .reduce(
        (sum, b) => sum + (b.status === "CHARGING" ? b.currentDrawKw : 0),
        0,
      )
      .toFixed(1),
  );
}

function getDynamicTariffSatsPerKwh(): number {
  const activeLoad = getActiveLoadKw();
  const scarcityFactor = 100 / Math.max(state.bessSocPercent, 15);
  const loadRatio = 1 + activeLoad / (state.solarIrradianceKw + 15);
  return Math.round(state.baseRateSatsPerKwh * scarcityFactor * loadRatio);
}

// 1-Second Digital Twin Hardware Telemetry Loop
setInterval(() => {
  for (const bay of state.bays) {
    if (bay.status === "CHARGING") {
      // Accelerated simulation speed so judges see kWh & SoC climb live on stage
      const stepKwh = Number((bay.maxPowerKw * 0.008).toFixed(2));
      bay.deliveredKwh = Number(
        Math.min(bay.allocatedKwh, bay.deliveredKwh + stepKwh).toFixed(2),
      );

      const socGain = (stepKwh / bay.batteryCapacityKwh) * 100;
      bay.vehicleSocPercent = Number(
        Math.min(100, bay.vehicleSocPercent + socGain).toFixed(1),
      );

      if (
        bay.deliveredKwh >= bay.allocatedKwh ||
        bay.vehicleSocPercent >= 100
      ) {
        bay.status = "COMPLETED";
        bay.currentDrawKw = 0;
      }
    }
  }
}, 1000);

// GET Station Telemetry
app.get("/api/station", (_req, res) => {
  const activeLoadKw = getActiveLoadKw();
  res.json({
    ...state,
    activeLoadKw,
    netBessFlowKw: Number((state.solarIrradianceKw - activeLoadKw).toFixed(1)),
    dynamicTariffSatsPerKwh: getDynamicTariffSatsPerKwh(),
  });
});

// POST Update Solar Canopy & Stationary BESS Sliders
app.post("/api/telemetry/environment", (req, res) => {
  const { solarIrradianceKw, bessSocPercent } = req.body;
  if (typeof solarIrradianceKw === "number")
    state.solarIrradianceKw = solarIrradianceKw;
  if (typeof bessSocPercent === "number") state.bessSocPercent = bessSocPercent;
  res.json({ ok: true, dynamicTariffSatsPerKwh: getDynamicTariffSatsPerKwh() });
});

// POST L402 Protected Endpoint: Energize EV Bay Contactor
app.post("/api/bays/:id/energize", (req, res) => {
  const bayId = Number(req.params.id);
  const bay = state.bays.find((b) => b.bayId === bayId);
  if (!bay) return res.status(404).json({ error: "EV Bay not found" });

  const authHeader = req.headers.authorization;
  const requestedKwh = Number(
    req.body.kwh || (bay.tier === "EMOBILITY_3KW" ? 2.5 : 25),
  );
  const authMode = req.body.authMode || "HUMAN_QR";

  // STEP 1: No L402 Header -> Issue HTTP 402 Payment Required Challenge
  if (!authHeader || !authHeader.startsWith("L402 ")) {
    const tariff = getDynamicTariffSatsPerKwh();
    const totalSats = Math.max(10, Math.round(requestedKwh * tariff));
    const challenge = createL402Challenge(
      bayId,
      requestedKwh,
      totalSats,
      bay.tier,
    );

    bay.status = "AWAITING_L402";
    bay.authMode = authMode;

    const wwwAuthHeader = `L402 macaroon="${challenge.macaroonBase64}", invoice="${challenge.invoice}"`;
    res.setHeader("WWW-Authenticate", wwwAuthHeader);

    return res.status(402).json({
      status: 402,
      message:
        "Payment Required: Settle BOLT11 Invoice to unlock L402 Macaroon",
      bayId,
      requestedKwh,
      tariffSatsPerKwh: tariff,
      totalSats,
      wwwAuthenticate: wwwAuthHeader,
      macaroon: challenge.macaroonBase64,
      invoice: challenge.invoice,
      paymentHash: challenge.paymentHashHex,
      caveats: challenge.caveats,
      demoPreimage: challenge.demoPreimageHex,
    });
  }

  // STEP 2: Client presents `Authorization: L402 <macaroon>:<preimage>`
  const tokenPart = authHeader.replace("L402 ", "").trim();
  const [macaroonBase64, preimageHex] = tokenPart.split(":");

  const verification = verifyL402Credential(macaroonBase64, preimageHex, bayId);
  if (!verification.valid) {
    return res.status(401).json({
      status: 401,
      error: verification.reason,
    });
  }

  // STEP 3: Cryptographic Verification Passed -> Trigger OCPP RemoteStartTransaction
  bay.status = "CHARGING";
  bay.authMode = authMode;
  bay.allocatedKwh = verification.allocatedKwh || requestedKwh;
  bay.deliveredKwh = 0;
  bay.currentDrawKw = bay.maxPowerKw;
  bay.lastPaymentHash = verification.paymentHash || null;

  return res.status(200).json({
    status: 200,
    ocppAction: "RemoteStartTransaction.conf",
    ocppStatus: "Accepted",
    bayId: bay.bayId,
    allocatedKwh: bay.allocatedKwh,
    paymentHashVerified: verification.paymentHash,
    message: `Contactor Closed: Delivering ${bay.maxPowerKw} kW (${bay.voltageV}V) to ${bay.vehicleModel}`,
  });
});

// POST Reset Bay
app.post("/api/bays/:id/reset", (req, res) => {
  const bay = state.bays.find((b) => b.bayId === Number(req.params.id));
  if (!bay) return res.status(404).json({ error: "Bay not found" });

  bay.status = "IDLE";
  bay.authMode = null;
  bay.allocatedKwh = 0;
  bay.deliveredKwh = 0;
  bay.currentDrawKw = 0;
  bay.vehicleSocPercent = bay.tier === "EMOBILITY_3KW" ? 20 : 28;
  res.json({ ok: true });
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(
    `⚡ Volt402-EV L402 Gateway listening on http://localhost:${PORT}`,
  );
});
