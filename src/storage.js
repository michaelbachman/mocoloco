const LS = typeof localStorage !== 'undefined' ? localStorage : null

export function getBaselineKey(pair){ return `baseline:${pair}` }
export function getBaseline(pair){
  if(!LS) return null
  const raw = LS.getItem(getBaselineKey(pair))
  if(!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function setBaseline(pair, price, atIso){
  if(!LS) return
  const payload = { price, at: atIso }
  LS.setItem(getBaselineKey(pair), JSON.stringify(payload))
  return payload
}

export function logBuffer(){
  const buf = []
  const max = 400
  let flushHandle = null
  const listeners = new Set()
  function push(line){
    buf.unshift(line)
    if(buf.length > max) buf.pop()
    schedule()
  }
  function schedule(){
    if(flushHandle) return
    flushHandle = requestAnimationFrame(()=>{
      flushHandle = null
      listeners.forEach(fn=>fn([...buf]))
    })
  }
  function on(fn){ listeners.add(fn); fn([...buf]); return ()=>listeners.delete(fn) }
  return { push, on }
}
