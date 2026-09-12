const PC_TRACK_URL = 'https://api.qishui.com/luna/pc/track_v2?aid=386088'

export async function resolvePlaybackUrl(id, headers, requestJson, logger) {
  try {
    const { json } = await requestJson(PC_TRACK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        track_id: id,
        media_type: 'track',
        queue_type: 'search_one_track',
        scene_name: 'search'
      })
    })
    const player = json.track_player || json.data?.track_player
    const direct = audioUrl(player)
    if (direct) return direct
    const infoUrl = player?.url_player_info
    if (officialPlayerUrl(infoUrl)) {
      const info = await requestJson(infoUrl)
      const audio = audioUrl(info.json)
      if (audio) return audio
    }
  } catch {
    logger?.debug('Qishui account playback unavailable; checking official share audio')
  }

  const response = await fetch(
    `https://music.douyin.com/qishui/share/track?track_id=${encodeURIComponent(id)}`,
    { signal: AbortSignal.timeout(15000) }
  )
  if (!response.ok) throw new Error(`汽水音乐分享页 HTTP ${response.status}`)
  const text = await response.text()
  const match = text.match(/_ROUTER_DATA\s*=\s*({.*?});/s)
  if (!match) throw new Error('汽水音乐分享页未返回播放信息')
  const data = JSON.parse(match[1])
  const option = data.loaderData?.track_page?.audioWithLyricsOption
  if (String(option?.track_id || option?.trackInfo?.id || '') !== id) {
    throw new Error('汽水音乐返回的歌曲与请求不一致')
  }
  if (option.encrypt || !httpUrl(option.url)) {
    throw new Error('汽水音乐未提供可直接播放的音频')
  }
  if (option.offsetDuration > 0 && option.offsetDuration + 1 < option.duration) {
    logger?.info('Qishui official share audio is a preview; full playback is unavailable')
  }
  return option.url
}

function httpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : ''
}

function officialPlayerUrl(value) {
  if (!httpUrl(value)) return false
  const url = new URL(value)
  return (
    url.protocol === 'https:' &&
    ['qishui.com', 'douyin.com', 'byteplusapi.com', 'volcengineapi.com', 'bytedanceapi.com'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  )
}

function audioUrl(value) {
  if (!value || typeof value !== 'object') return ''
  if (value.PlayAuth || value.play_auth || value.spade_a || value.encrypt) return ''
  for (const key of [
    'MainPlayUrl',
    'BackupPlayUrl',
    'main_url',
    'backup_url',
    'audio_url',
    'play_url'
  ]) {
    const url = httpUrl(value[key])
    if (url) return url
  }
  for (const nested of Object.values(value)) {
    const url = audioUrl(nested)
    if (url) return url
  }
  return ''
}
