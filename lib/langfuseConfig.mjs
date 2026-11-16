// @ts-check
/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: false } | { enabled: true, baseUrl: string, publicKey: string, secretKey: string }}
 */
export function getLangfuseConfig(env = process.env) {
  const explicitlyEnabled =
    String(env.LANGFUSE_ENABLED || "").trim().toLowerCase() === "true";

  if (!explicitlyEnabled) {
    return { enabled: false };
  }

  const baseUrl = env.LANGFUSE_HOST || env.LANGFUSE_BASEURL;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;

  if (!baseUrl || !publicKey || !secretKey) {
    return { enabled: false };
  }

  return {
    enabled: true,
    baseUrl,
    publicKey,
    secretKey,
  };
}

/**
 * @param {any} value
 * @returns {any}
 */
function removeNullMediaFields(value) {
  if (Array.isArray(value)) {
    return value.map(removeNullMediaFields);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => {
        return !(
          entryValue === null && (key === "audio" || key === "input_audio")
        );
      })
      .map(([key, entryValue]) => [key, removeNullMediaFields(entryValue)])
  );
}

/**
 * @param {any} completion
 * @returns {any}
 */
export function normalizeLangfuseCompletion(completion) {
  return removeNullMediaFields(completion);
}
