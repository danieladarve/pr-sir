/** Is the copy running here behind the newest release?
 *  Numeric collation compares each run of digits as a number, so 0.9.0 counts
 *  as older than 0.10.0 rather than newer. A missing latest means the check
 *  could not run, which is never a reason to nag. */
export const isOutdated = (current, latest) => {
  if (!current || !latest) return false
  const clean = (v) => String(v).trim().replace(/^v/, '')
  return clean(current).localeCompare(clean(latest), undefined, { numeric: true }) < 0
}
