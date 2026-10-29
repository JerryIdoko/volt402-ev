import {
  BatteryCharging,
  Bot,
  CheckCircle2,
  Cpu,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Sun,
  Terminal,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

const API_BASE = "http://localhost:4000/api";

interface EvChargingBay {
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
}

interface PendingChallenge {
  bayId: number;
  macaroon: string;
  invoice: string;
  demoPreimage: string;
  totalSats: number;
  requestedKwh: number;
  caveats: string[];
}

interface ProtocolLog {
  id: string;
  time: string;
  type: "CHALLENGE_402" | "PREIMAGE_SETTLED" | "AUTH_200_OCPP" | "ERROR";
  title: string;
  details: string[];
}

export default function App() {
  const [solarKw, setSolarKw] = useState(85);
  const [bessSoc, setBessSoc] = useState(82);
  const [activeLoadKw, setActiveLoadKw] = useState(0);
  const [netBessFlowKw, setNetBessFlowKw] = useState(85);
  const [tariffSats, setTariffSats] = useState(180);
  const [bays, setBays] = useState<EvChargingBay[]>([]);
  const [challenges, setChallenges] = useState<
    Record<number, PendingChallenge>
  >({});
  const [logs, setLogs] = useState<ProtocolLog[]>([]);

  const appendLog = (
    type: ProtocolLog["type"],
    title: string,
    details: string[],
  ) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [
      { id: `${Date.now()}-${Math.random()}`, time, type, title, details },
      ...prev.slice(0, 19),
    ]);
  };

  const fetchStation = async () => {
    try {
      const res = await fetch(`${API_BASE}/station`);
      const data = await res.json();
      setBays(data.bays);
      setActiveLoadKw(data.activeLoadKw);
      setNetBessFlowKw(data.netBessFlowKw);
      setTariffSats(data.dynamicTariffSatsPerKwh);
    } catch (e) {
      // Gateway starting up
    }
  };

  useEffect(() => {
    fetchStation();
    const interval = setInterval(fetchStation, 1000);
    return () => clearInterval(interval);
  }, []);

  const updateEnvironment = async (newSolar: number, newBess: number) => {
    setSolarKw(newSolar);
    setBessSoc(newBess);
    await fetch(`${API_BASE}/telemetry/environment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        solarIrradianceKw: newSolar,
        bessSocPercent: newBess,
      }),
    });
    fetchStation();
  };

  // Step 1 of Manual QR Flow: Trigger HTTP 402 Payment Required Challenge
  const request402Challenge = async (bay: EvChargingBay) => {
    const defaultKwh =
      bay.tier === "EMOBILITY_3KW"
        ? 3
        : bay.tier === "AC_LEVEL2_22KW"
          ? 15
          : 35;
    const res = await fetch(`${API_BASE}/bays/${bay.bayId}/energize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kwh: defaultKwh, authMode: "HUMAN_QR" }),
    });

    if (res.status === 402) {
      const data = await res.json();
      setChallenges((prev) => ({
        ...prev,
        [bay.bayId]: {
          bayId: bay.bayId,
          macaroon: data.macaroon,
          invoice: data.invoice,
          demoPreimage: data.demoPreimage,
          totalSats: data.totalSats,
          requestedKwh: data.requestedKwh,
          caveats: data.caveats,
        },
      }));

      appendLog(
        "CHALLENGE_402",
        `HTTP 402 Challenge -> Bay #${bay.bayId} (${bay.vehicleModel})`,
        [
          `WWW-Authenticate: L402 macaroon="${data.macaroon.slice(0, 28)}...", invoice="${data.invoice.slice(0, 28)}..."`,
          `Caveats: [${data.caveats.join(", ")}]`,
          `Invoice Amount: ${data.totalSats} sats (${data.requestedKwh} kWh @ ${data.tariffSatsPerKwh} sats/kWh)`,
        ],
      );
      fetchStation();
    }
  };

  // Step 2 of Manual QR Flow: Settle Preimage & Send Authorization: L402 Header
  const settleL402Challenge = async (
    bayId: number,
    challenge: PendingChallenge,
    mode: "HUMAN_QR" | "M2M_AUTONOMOUS",
  ) => {
    appendLog(
      "PREIMAGE_SETTLED",
      `Lightning Invoice Settled -> Bay #${bayId}`,
      [
        `Revealed 32-Byte Preimage (r): ${challenge.demoPreimage.slice(0, 36)}...`,
        `Sending Header -> Authorization: L402 ${challenge.macaroon.slice(0, 20)}...:${challenge.demoPreimage.slice(0, 20)}...`,
      ],
    );

    const res = await fetch(`${API_BASE}/bays/${bayId}/energize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `L402 ${challenge.macaroon}:${challenge.demoPreimage}`,
      },
      body: JSON.stringify({ kwh: challenge.requestedKwh, authMode: mode }),
    });

    if (res.status === 200) {
      const data = await res.json();
      appendLog(
        "AUTH_200_OCPP",
        `HTTP 200 OK • ${data.ocppAction} -> Bay #${bayId}`,
        [
          `Stateless Check Passed: SHA256(preimage) == ${data.paymentHashVerified.slice(0, 24)}...`,
          `${data.message}`,
        ],
      );
      setChallenges((prev) => {
        const copy = { ...prev };
        delete copy[bayId];
        return copy;
      });
      fetchStation();
    }
  };

  // 1-Click Autonomous EV M2M Plug & Charge Handshake
  const triggerAutonomousM2M = async (bay: EvChargingBay) => {
    const defaultKwh =
      bay.tier === "EMOBILITY_3KW"
        ? 3
        : bay.tier === "AC_LEVEL2_22KW"
          ? 15
          : 40;
    const res402 = await fetch(`${API_BASE}/bays/${bay.bayId}/energize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kwh: defaultKwh, authMode: "M2M_AUTONOMOUS" }),
    });

    if (res402.status === 402) {
      const data = await res402.json();
      appendLog(
        "CHALLENGE_402",
        `[M2M Agent] HTTP 402 Received by ${bay.vehicleModel} (Bay #${bay.bayId})`,
        [
          `WWW-Authenticate: L402 macaroon="${data.macaroon.slice(0, 24)}...", invoice="${data.invoice.slice(0, 24)}..."`,
          `EV Onboard NWC Wallet auto-paying ${data.totalSats} sats for ${data.requestedKwh} kWh...`,
        ],
      );

      setTimeout(async () => {
        await settleL402Challenge(
          bay.bayId,
          {
            bayId: bay.bayId,
            macaroon: data.macaroon,
            invoice: data.invoice,
            demoPreimage: data.demoPreimage,
            totalSats: data.totalSats,
            requestedKwh: data.requestedKwh,
            caveats: data.caveats,
          },
          "M2M_AUTONOMOUS",
        );
      }, 450);
    }
  };

  const resetBay = async (bayId: number) => {
    await fetch(`${API_BASE}/bays/${bayId}/reset`, { method: "POST" });
    setChallenges((prev) => {
      const copy = { ...prev };
      delete copy[bayId];
      return copy;
    });
    fetchStation();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6">
      {/* Top Header & Live Solar Microgrid Telemetry */}
      <header className="max-w-7xl mx-auto mb-6 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-5 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Zap className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight text-white">
                  Volt402-EV
                </h1>
                <span className="text-xs font-mono uppercase px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  L402 + OCPP Digital Twin
                </span>
              </div>
              <p className="text-sm text-slate-400">
                Autonomous Solar Canopy & Stationary BESS Supercharger gated by
                Lightning HTTP 402 Macaroons
              </p>
            </div>
          </div>

          {/* Live Dynamic Tariff Display */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5">
              <div className="text-xs text-slate-400 uppercase font-mono">
                Active EV Load
              </div>
              <div className="text-xl font-bold text-cyan-400 font-mono">
                {activeLoadKw} kW
              </div>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5">
              <div className="text-xs text-slate-400 uppercase font-mono">
                Net BESS Flow
              </div>
              <div
                className={`text-xl font-bold font-mono ${netBessFlowKw >= 0 ? "text-emerald-400" : "text-rose-400"}`}
              >
                {netBessFlowKw >= 0 ? `+${netBessFlowKw}` : netBessFlowKw} kW
              </div>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-5 py-2.5">
              <div className="text-xs text-amber-300 uppercase font-mono">
                Live L402 Tariff
              </div>
              <div className="text-2xl font-extrabold text-amber-400 font-mono">
                {tariffSats} sats/kWh
              </div>
            </div>
          </div>
        </div>

        {/* Interactive Solar Canopy & Stationary BESS Sliders */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-5">
          <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <Sun className="w-4 h-4 text-amber-400" /> Solar PV Canopy
                Generation
              </span>
              <span className="font-mono text-sm font-bold text-amber-400">
                {solarKw} kW / 120 kWp
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={120}
              value={solarKw}
              onChange={(e) =>
                updateEnvironment(Number(e.target.value), bessSoc)
              }
              className="w-full accent-amber-400 cursor-pointer"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>0 kW (Night)</span>
              <span>60 kW (Overcast)</span>
              <span>120 kW (Peak Sun)</span>
            </div>
          </div>

          <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-4">
            <div className="flex justify-between items-center mb-2">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <BatteryCharging className="w-4 h-4 text-emerald-400" />{" "}
                Stationary BESS Buffer (250 kWh LiFePO4)
              </span>
              <span className="font-mono text-sm font-bold text-emerald-400">
                {bessSoc}% SoC
              </span>
            </div>
            <input
              type="range"
              min={15}
              max={100}
              value={bessSoc}
              onChange={(e) =>
                updateEnvironment(solarKw, Number(e.target.value))
              }
              className="w-full accent-emerald-400 cursor-pointer"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>15% (Scarcity Surge)</span>
              <span>50% (Balanced)</span>
              <span>100% (Surplus Discount)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content: 6 EV Charging Bays (Left) + Live L402 Protocol Inspector (Right) */}
      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 6 EV Charging Bays Grid */}
        <section className="lg:col-span-7 grid grid-cols-1 md:grid-cols-2 gap-4">
          {bays.map((bay) => {
            const challenge = challenges[bay.bayId];
            const progressPct =
              bay.allocatedKwh > 0
                ? Math.min(
                    100,
                    Math.round((bay.deliveredKwh / bay.allocatedKwh) * 100),
                  )
                : 0;

            return (
              <div
                key={bay.bayId}
                className={`rounded-2xl border p-4 transition-all flex flex-col justify-between ${
                  bay.status === "CHARGING"
                    ? "bg-emerald-950/20 border-emerald-500/50 shadow-lg shadow-emerald-950/30"
                    : bay.status === "AWAITING_L402"
                      ? "bg-amber-950/20 border-amber-500/50"
                      : "bg-slate-900/90 border-slate-800"
                }`}
              >
                <div>
                  {/* Bay Header */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <span className="text-xs font-mono text-slate-400">
                        {bay.connector}
                      </span>
                      <h3 className="text-base font-bold text-white">
                        {bay.name}
                      </h3>
                    </div>
                    <span
                      className={`text-xs font-mono px-2.5 py-1 rounded-full font-semibold ${
                        bay.status === "CHARGING"
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse"
                          : bay.status === "AWAITING_L402"
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                            : bay.status === "COMPLETED"
                              ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                              : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {bay.status}
                    </span>
                  </div>

                  {/* Vehicle & Telemetry Spec */}
                  <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-3 mb-3 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">Connected EV:</span>
                      <span className="font-semibold text-slate-200">
                        {bay.vehicleModel}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">Contactor Output:</span>
                      <span className="font-mono text-cyan-400">
                        {bay.currentDrawKw} kW / {bay.maxPowerKw} kW (
                        {bay.voltageV}V)
                      </span>
                    </div>

                    {/* Vehicle Battery SoC Bar */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400">
                          Vehicle Battery SoC
                        </span>
                        <span className="font-mono font-bold text-emerald-400">
                          {bay.vehicleSocPercent}%
                        </span>
                      </div>
                      <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 transition-all duration-500"
                          style={{ width: `${bay.vehicleSocPercent}%` }}
                        />
                      </div>
                    </div>

                    {/* Metered L402 Energy Caveat Progress */}
                    {bay.allocatedKwh > 0 && (
                      <div className="pt-1">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-slate-400">
                            L402 Macaroon Quota
                          </span>
                          <span className="font-mono text-amber-300">
                            {bay.deliveredKwh} / {bay.allocatedKwh} kWh (
                            {progressPct}%)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-400 transition-all duration-500"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Pending HTTP 402 Challenge Box */}
                  {challenge && bay.status === "AWAITING_L402" && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3 text-xs space-y-2">
                      <div className="flex items-center justify-between text-amber-300 font-semibold">
                        <span>HTTP 402 Invoice Issued</span>
                        <span className="font-mono">
                          {challenge.totalSats} sats
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-slate-300 break-all bg-slate-950 p-2 rounded border border-slate-800">
                        {challenge.invoice}
                      </div>
                      <button
                        onClick={() =>
                          settleL402Challenge(bay.bayId, challenge, "HUMAN_QR")
                        }
                        className="w-full py-2 px-3 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold flex items-center justify-center gap-1.5 transition"
                      >
                        <ShieldCheck className="w-4 h-4" /> Simulate Preimage &
                        Unlock Contactor
                      </button>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="pt-1 flex gap-2">
                  {bay.status === "IDLE" && (
                    <>
                      <button
                        onClick={() => triggerAutonomousM2M(bay)}
                        className="flex-1 py-2 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition"
                      >
                        <Bot className="w-4 h-4" /> M2M Auto-Charge
                      </button>
                      <button
                        onClick={() => request402Challenge(bay)}
                        className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs flex items-center justify-center gap-1.5 border border-slate-700 transition"
                      >
                        <QrCode className="w-4 h-4 text-amber-400" /> QR 402
                      </button>
                    </>
                  )}

                  {(bay.status === "CHARGING" ||
                    bay.status === "COMPLETED" ||
                    bay.status === "AWAITING_L402") && (
                    <button
                      onClick={() => resetBay(bay.bayId)}
                      className="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Disconnect & Reset
                      Bay
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Live L402 + OCPP Cryptographic Packet Inspector */}
        <section className="lg:col-span-5 bg-slate-900/95 border border-slate-800 rounded-2xl p-4 flex flex-col h-[700px]">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-amber-400" />
              <h2 className="font-bold text-white text-base">
                Live L402 + OCPP Packet Inspector
              </h2>
            </div>
            <button
              onClick={() => setLogs([])}
              className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded bg-slate-800"
            >
              Clear
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1 font-mono text-xs">
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 p-6">
                <Cpu className="w-10 h-10 mb-2 text-slate-600" />
                <p className="font-sans text-sm text-slate-400 mb-1">
                  No L402 packets captured yet.
                </p>
                <p className="font-sans text-xs text-slate-500">
                  Click <strong>"M2M Auto-Charge"</strong> or{" "}
                  <strong>"QR 402"</strong> on any EV bay to inspect the live{" "}
                  <code>HTTP 402</code> challenge, Macaroon caveats, and SHA-256
                  preimage verification.
                </p>
              </div>
            ) : (
              logs.map((log) => (
                <div
                  key={log.id}
                  className={`p-3 rounded-xl border ${
                    log.type === "CHALLENGE_402"
                      ? "bg-amber-950/20 border-amber-500/40 text-amber-200"
                      : log.type === "PREIMAGE_SETTLED"
                        ? "bg-cyan-950/20 border-cyan-500/40 text-cyan-200"
                        : "bg-emerald-950/20 border-emerald-500/40 text-emerald-200"
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] opacity-75 mb-1">
                    <span>{log.type}</span>
                    <span>{log.time}</span>
                  </div>
                  <div className="font-bold text-white mb-1.5 flex items-center gap-1.5">
                    {log.type === "AUTH_200_OCPP" && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                    {log.title}
                  </div>
                  <div className="space-y-1 text-[11px] text-slate-300 break-all bg-slate-950/80 p-2 rounded-lg border border-slate-800/80">
                    {log.details.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
