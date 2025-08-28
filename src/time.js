export function nowPTDate(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  })
  const parts = fmt.formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {})
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-07:00`
  return { iso, parts }
}

export function inQuietHoursPT(d = new Date()) {
  const tz = 'America/Los_Angeles'
  const pt = new Date(d.toLocaleString('en-US', { timeZone: tz }))
  const h = pt.getHours()
  return (h >= 23 || h < 7)
}
