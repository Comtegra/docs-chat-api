import assert from "node:assert/strict";
import test from "node:test";

import { validateTenantConfig } from "../lib/tenants/registry.mjs";
import { syntheticTenant } from "./helpers/tenants.mjs";

test("limity ochronne: tenant z NAT-em ma dobowy per IP, równoległość per IP i sufit tokenów; brak pól = bezpieczne domyślne", () => {
  const gated = validateTenantConfig(syntheticTenant({}));
  assert.equal(gated.limits.perIpDaily, 300);
  assert.equal(gated.limits.maxOutputTokens, 1500);
  assert.equal(gated.limits.maxConcurrentPerIp, 5);

  const raw = syntheticTenant({});
  delete raw.limits.perIpDaily; delete raw.limits.maxOutputTokens; delete raw.limits.maxConcurrentPerIp;
  const minimal = validateTenantConfig(raw);
  assert.equal(minimal.limits.perIpDaily, null);
  assert.equal(minimal.limits.maxOutputTokens, 1500);
  assert.equal(minimal.limits.maxConcurrentPerIp, 5);

  raw.limits.maxOutputTokens = 10; // poniżej minimum
  assert.throws(() => validateTenantConfig(raw), /maxOutputTokens/);
});
