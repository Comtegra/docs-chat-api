export type LangfuseConfig =
  | { enabled: false }
  | {
      enabled: true;
      baseUrl: string;
      publicKey: string;
      secretKey: string;
    };

export function getLangfuseConfig(
  env?: Record<string, string | undefined>
): LangfuseConfig;

export function normalizeLangfuseCompletion<T>(completion: T): T;
