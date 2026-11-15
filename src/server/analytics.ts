const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || '';
const POSTHOG_HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');

export function trackEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {}
): void {
  if (!POSTHOG_API_KEY) return;

  const payload = {
    api_key: POSTHOG_API_KEY,
    event,
    distinct_id: distinctId,
    properties: {
      ...properties,
      $lib: 'baron-pit-server'
    },
    timestamp: new Date().toISOString()
  };

  void fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch((err) => {
    console.error('PostHog capture error:', err);
  });
}
