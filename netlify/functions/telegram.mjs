// /.netlify/functions/telegram.mjs
export default async (req, context) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const { message } = await req.json()
    if (!message) return new Response('Missing message', { status: 400 })
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (!token || !chatId) return new Response('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID', { status: 500 })
    const url = `https://api.telegram.org/bot${token}/sendMessage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      return new Response('Telegram send failed: ' + JSON.stringify(data), { status: 502 })
    }
    return new Response('ok', { status: 200 })
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 })
  }
}
