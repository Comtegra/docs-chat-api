import assert from "node:assert/strict";
import test from "node:test";

import {
  getLangfuseConfig,
  normalizeLangfuseCompletion,
} from "../lib/langfuseConfig.mjs";

test("keeps Langfuse disabled unless explicitly enabled", () => {
  const config = getLangfuseConfig({
    LANGFUSE_HOST: "http://langfuse.apps.svc.cluster.local:3000",
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
  });

  assert.equal(config.enabled, false);
});

test("enables Langfuse only with explicit flag and complete config", () => {
  const config = getLangfuseConfig({
    LANGFUSE_ENABLED: " true ",
    LANGFUSE_HOST: "http://langfuse:3000",
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
  });

  assert.deepEqual(config, {
    enabled: true,
    baseUrl: "http://langfuse:3000",
    publicKey: "pk-test",
    secretKey: "sk-test",
  });
});

test("removes null audio fields from Langfuse completion payloads", () => {
  const completion = normalizeLangfuseCompletion({
    choices: [
      {
        message: {
          role: "assistant",
          content: "ok",
          audio: null,
        },
      },
    ],
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
  });

  assert.deepEqual(completion, {
    choices: [
      {
        message: {
          role: "assistant",
          content: "ok",
        },
      },
    ],
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    },
  });
});
