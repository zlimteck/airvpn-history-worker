export type AirVpnHealth = "ok" | "warning" | "error";

export interface AirVpnServer {
  public_name: string;
  country_name: string;
  country_code: string;
  location: string;
  continent: string;
  bw: number;
  bw_max: number;
  users: number;
  currentload: number;
  health: AirVpnHealth;
  warning?: string;
}

export interface AirVpnStatusResponse {
  result: string;
  servers: AirVpnServer[];
  countries: unknown[];
  continents: unknown[];
  planets: unknown[];
}

const AIRVPN_STATUS_URL = "https://airvpn.org/api/status/";

export class AirVpnFetchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "AirVpnFetchError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;

export async function fetchAirVpnStatus(): Promise<AirVpnStatusResponse> {
  let response: Response;
  try {
    response = await fetch(AIRVPN_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AirVpnFetchError(`AirVPN request failed (network error or timeout): ${reason}`);
  }

  if (response.status === 429) {
    throw new AirVpnFetchError("Rate limited by AirVPN", 429);
  }
  if (!response.ok) {
    throw new AirVpnFetchError(`AirVPN status request failed: HTTP ${response.status}`, response.status);
  }

  let body: AirVpnStatusResponse;
  try {
    body = (await response.json()) as AirVpnStatusResponse;
  } catch (err) {
    throw new AirVpnFetchError("AirVPN response was not valid JSON");
  }

  if (body.result !== "ok" || !Array.isArray(body.servers)) {
    throw new AirVpnFetchError(`AirVPN status response not ok: ${body.result}`);
  }

  return body;
}
