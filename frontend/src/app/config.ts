/** Runtime configuration written by CDK to /config.json (copy config.example.json for local dev). */
export interface RuntimeConfig {
  stage: string;
  region: string;
  /** IANA time zone to show times in (the exec's); defaults to Asia/Singapore. */
  timeZone?: string;
  apiUrl: string;
  cognito: { authority: string; clientId: string; domain: string };
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('Missing /config.json. For local development copy public/config.example.json to public/config.json and fill in the stack outputs.');
  }
  const config = (await res.json()) as RuntimeConfig;
  if (!config.apiUrl.endsWith('/')) config.apiUrl += '/';
  return config;
}
