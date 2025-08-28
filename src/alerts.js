// Rolling-baseline alert helper (alerts disabled by default)
const key = (pairKey) => ({
  baseline: `baseline:${pairKey}`,
  lastAlertAt: `lastAlertAt:${pairKey}`,
})

function nowPT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
}
export function inQuietHoursPT(hours = { start: 23, end: 7 }) {
  const h = nowPT().getHours()
  return hours.start > hours.end ? (h >= hours.start || h < hours.end) : (h >= hours.start && h < hours.end)
}

export function loadBaseline(pairKey) {
  const v = localStorage.getItem(key(pairKey).baseline)
  return v ? Number(v) : null
}
export function saveBaseline(pairKey, price) {
  if (Number.isFinite(price)) localStorage.setItem(key(pairKey).baseline, String(price))
}
export function loadLastAlertAt(pairKey) {
  const v = localStorage.getItem(key(pairKey).lastAlertAt)
  return v ? Number(v) : 0
}
export function saveLastAlertAt(pairKey, ts=Date.now()) {
  localStorage.setItem(key(pairKey).lastAlertAt, String(ts))
}

export function checkRollingAlert({
  pairKey, price, thresholdPct = 1, quiet = { start: 23, end: 7 },
  alertsEnabled = false, onNotify = () => {}, log = () => {}
}) {
  if (!Number.isFinite(price)) return
  let baseline = loadBaseline(pairKey)
  if (!Number.isFinite(baseline)) {
    saveBaseline(pairKey, price)
    log(`Baseline initialized @ ${price.toFixed(2)}`)
    return
  }
  const changePct = ((price - baseline) / baseline) * 100
  if (Math.abs(changePct) >= thresholdPct) {
    const direction = changePct >= 0 ? 'up' : 'down'
    const usdDiff = price - baseline
    const payload = {
      pair: pairKey.replace(':', '/'),
      current: price,
      changePct: Number(changePct.toFixed(2)),
      usdDiff: Number(usdDiff.toFixed(2)),
      direction,
      priorBaseline: baseline,
      atPT: nowPT().toLocaleString('en-US', { hour12: false }),
    }
    if (inQuietHoursPT(quiet)) {
      log(`(quiet) Δ=${payload.changePct}% — baseline ${baseline.toFixed(2)} → ${price.toFixed(2)} @ ${payload.atPT}`)
      saveBaseline(pairKey, price)
      saveLastAlertAt(pairKey)
      return
    }
    if (alertsEnabled) onNotify(payload)
    else log(`(alerts OFF) Δ=${payload.changePct}% ($${payload.usdDiff}) ${direction}. ${baseline.toFixed(2)} → ${price.toFixed(2)} @ ${payload.atPT}`)
    saveBaseline(pairKey, price)
    saveLastAlertAt(pairKey)
  }
}
