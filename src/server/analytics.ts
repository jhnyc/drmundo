const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || '';
const POSTHOG_HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');

export function trackEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {}
): void {
  const timestamp = new Date().toISOString();

  // Structured JSON log for Render logs / Log Streams
  console.log(
    JSON.stringify({
      ts: timestamp,
      event,
      distinctId,
      ...properties
    })
  );

  // Forward to PostHog if configured (fire-and-forget)
  if (!POSTHOG_API_KEY) return;

  void fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      event,
      distinct_id: distinctId,
      properties,
      timestamp
    })
  }).catch(() => {});
}
