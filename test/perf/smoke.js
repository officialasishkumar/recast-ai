// k6 smoke test for the Recast AI api-gateway. Runs in CI on PRs that touch
// gateway code to flag obvious latency or error-rate regressions before merge.
//
// Defaults: 5 VUs for 30s, p95 < 250ms, error rate < 1%. Override with the
// usual k6 environment variables (K6_VUS, K6_DURATION, etc).

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errors = new Rate("recast_smoke_errors");

export const options = {
  scenarios: {
    constant_load: {
      executor: "constant-vus",
      vus: 5,
      duration: __ENV.K6_DURATION || "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<250", "p(99)<500"],
    recast_smoke_errors: ["rate<0.01"],
  },
};

const BASE = __ENV.RECAST_BASE_URL || "http://localhost:8080";

export default function () {
  const health = http.get(`${BASE}/health`, { tags: { route: "/health" } });
  const okHealth = check(health, {
    "health 200": (r) => r.status === 200,
    "health body includes ok": (r) => (r.body || "").includes("ok"),
  });
  errors.add(!okHealth);

  const metrics = http.get(`${BASE.replace(":8080", ":9100")}/metrics`, {
    tags: { route: "/metrics" },
  });
  const okMetrics = check(metrics, {
    "metrics 200": (r) => r.status === 200,
    "exposes go_goroutines": (r) =>
      (r.body || "").includes("go_goroutines"),
  });
  errors.add(!okMetrics);

  sleep(0.2);
}
