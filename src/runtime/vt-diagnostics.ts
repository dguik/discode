type MetricTags = Record<string, string | number | boolean | undefined>;

const counters = new Map<string, number>();

function metricKey(name: string, tags?: MetricTags): string {
  if (!tags || Object.keys(tags).length === 0) return name;
  const tagText = Object.entries(tags)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
  if (tagText.length === 0) return name;
  return `${name}|${tagText}`;
}

export function incRuntimeMetric(name: string, tags?: MetricTags): void {
  const key = metricKey(name, tags);
  const current = counters.get(key) ?? 0;
  counters.set(key, current + 1);
}

export function getRuntimeMetric(name: string, tags?: MetricTags): number {
  return counters.get(metricKey(name, tags)) ?? 0;
}

export function getRuntimeMetricSnapshot(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

export function resetRuntimeMetrics(): void {
  counters.clear();
}

