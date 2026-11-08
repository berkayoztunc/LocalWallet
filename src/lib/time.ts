/** "Just now", "12 min ago", "3 h ago", "2 d ago" for a unix-seconds time. */
export function ago(secs: number | null | undefined): string {
  if (!secs) return "never";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
