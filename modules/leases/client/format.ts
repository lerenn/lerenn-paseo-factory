export function inTime(now: number, at: number): string {
  const sec = Math.round((at - now) / 1000);
  if (sec <= 0) return "expired";
  if (sec < 90) return `in ${sec} s`;
  const min = Math.round(sec / 60);
  return min < 90 ? `in ${min} min` : min < 2880 ? `in ${Math.round(min / 60)} h` : `in ${Math.round(min / 1440)} d`;
}
