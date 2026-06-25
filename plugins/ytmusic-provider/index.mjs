import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { runInNewContext } from 'vm'

// ─── Constants ──────────────────────────────────────────────────────────
const PROVIDER_ID = 'ytm'
const SETTINGS_COOKIE_KEY = 'cookie'
const SETTINGS_INNERTUBE_KEY = 'innertube'
const SETTINGS_OAUTH_TOKEN_KEY = 'oauth_token'

const YTM_DOMAIN = 'https://music.youtube.com'
const YT_BASE = 'https://www.youtube.com'
const YTM_API_BASE = 'https://music.youtube.com/youtubei/v1'
const YT_PLAYER_BASE = 'https://www.youtube.com/youtubei/v1'
const HARDCODED_API_KEY = 'AIzaSy...NX30'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 15000
const STREAM_PROXY_TOKEN_TTL_MS = 6 * 60 * 1000

// OAuth 2.0 Device Code Grant — auto-discovers client credentials from YouTube TV
// Approach ported from youtubei.js (LuanRT/YouTube.js) OAuth2.ts
const OAUTH_SCOPE = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content'
const OAUTH_CODE_URL = 'https://www.youtube.com/o/oauth2/device/code'
const OAUTH_TOKEN_URL = 'https://www.youtube.com/o/oauth2/token'
const OAUTH_REVOKE_URL = 'https://www.youtube.com/o/oauth2/revoke'
const YTTV_URL = 'https://www.youtube.com/tv'
const YTTV_UA = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version'

// Audio format priority: itag -> (container, bitrate)
// 141 = m4a 256kbps AAC, 251 = webm 160kbps Opus, 140 = m4a 128kbps AAC, 250 = webm 70kbps Opus
const PREFERRED_AUDIO_ITAGS = [141, 251, 140, 250, 171]

// ─── Navigation Path Constants (ported from ytmusicapi/navigation.py) ────
const CONTENT = ['contents', 0]
const RUN_TEXT = ['runs', 0, 'text']
const TAB_CONTENT = ['tabs', 0, 'tabRenderer', 'content']
const TAB_1_CONTENT = ['tabs', 1, 'tabRenderer', 'content']
const TAB_2_CONTENT = ['tabs', 2, 'tabRenderer', 'content']
const TWO_COLUMN_RENDERER = ['contents', 'twoColumnBrowseResultsRenderer']
const SINGLE_COLUMN = ['contents', 'singleColumnBrowseResultsRenderer']
const SINGLE_COLUMN_TAB = [...SINGLE_COLUMN, ...TAB_CONTENT]
const SECTION = ['sectionListRenderer']
const SECTION_LIST = [...SECTION, 'contents']
const SECTION_LIST_ITEM = [...SECTION, ...CONTENT]
const ITEM_SECTION = ['itemSectionRenderer', ...CONTENT]
const MUSIC_SHELF = ['musicShelfRenderer']
const GRID = ['gridRenderer']
const GRID_ITEMS = [...GRID, 'items']
const MENU = ['menu', 'menuRenderer']
const MENU_ITEMS = [...MENU, 'items']
const MENU_SERVICE = ['menuServiceItemRenderer', 'serviceEndpoint']
const TOGGLE_MENU = 'toggleMenuServiceItemRenderer'
const OVERLAY_RENDERER = ['musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer']
const PLAY_BUTTON = ['overlay', ...OVERLAY_RENDERER]
const NAVIGATION_BROWSE = ['navigationEndpoint', 'browseEndpoint']
const NAVIGATION_BROWSE_ID = [...NAVIGATION_BROWSE, 'browseId']
const PAGE_TYPE = ['browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType']
const WATCH_VIDEO_ID = ['watchEndpoint', 'videoId']
const PLAYLIST_ID = ['playlistId']
const WATCH_PLAYLIST_ID = ['watchEndpoint', ...PLAYLIST_ID]
const NAVIGATION_VIDEO_ID = ['navigationEndpoint', ...WATCH_VIDEO_ID]
const NAVIGATION_PLAYLIST_ID = ['navigationEndpoint', ...WATCH_PLAYLIST_ID]
const WATCH_PID = ['watchPlaylistEndpoint', ...PLAYLIST_ID]
const NAVIGATION_WATCH_PLAYLIST_ID = ['navigationEndpoint', ...WATCH_PID]
const NAVIGATION_VIDEO_TYPE = [
  'watchEndpoint', 'watchEndpointMusicSupportedConfigs', 'watchEndpointMusicConfig', 'musicVideoType'
]
const ICON_TYPE = ['icon', 'iconType']
const TITLE = ['title', 'runs', 0]
const TITLE_TEXT = ['title', ...RUN_TEXT]
const TEXT_RUNS = ['text', 'runs']
const TEXT_RUN = [...TEXT_RUNS, 0]
const TEXT_RUN_TEXT = [...TEXT_RUN, 'text']
const SUBTITLE = ['subtitle', ...RUN_TEXT]
const SUBTITLE_RUNS = ['subtitle', 'runs']
const SUBTITLE2 = [...SUBTITLE_RUNS, 2, 'text']
const THUMBNAIL = ['thumbnail', 'thumbnails']
const THUMBNAILS = ['thumbnail', 'musicThumbnailRenderer', ...THUMBNAIL]
const THUMBNAIL_RENDERER = ['thumbnailRenderer', 'musicThumbnailRenderer', ...THUMBNAIL]
const THUMBNAIL_OVERLAY_NAVIGATION = ['thumbnailOverlay', ...OVERLAY_RENDERER, 'playNavigationEndpoint']
const BADGE_PATH = [0, 'musicInlineBadgeRenderer', 'accessibilityData', 'accessibilityData', 'label']
const BADGE_LABEL = ['badges', ...BADGE_PATH]
const HEADER = ['header']
const HEADER_DETAIL = [...HEADER, 'musicDetailHeaderRenderer']
const EDITABLE_PLAYLIST_DETAIL_HEADER = ['musicEditablePlaylistDetailHeaderRenderer']
const DESCRIPTION_SHELF = ['musicDescriptionShelfRenderer']
const DESCRIPTION = ['description', ...RUN_TEXT]
const SECTION_LIST_CONTINUATION = ['continuationContents', 'sectionListContinuation']
const MRLIR = 'musicResponsiveListItemRenderer'
const MTRIR = 'musicTwoRowItemRenderer'
const MNIR = 'menuNavigationItemRenderer'

// Continuation paths (ported from ytmusicapi/continuations.py)
const CONTINUATION_TOKEN_PATH = [
  'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token'
]
const COMMAND_EXECUTOR_COMMANDS = [
  'continuationItemRenderer', 'continuationEndpoint', 'commandExecutorCommand', 'commands'
]
const CONTINUATION_ITEMS = [
  'onResponseReceivedActions', 0, 'appendContinuationItemsAction', 'continuationItems'
]

const DOT_SEPARATOR_RUN = { text: ' \u2022 ' }

// ─── Navigation Utilities (ported from navigation.py) ───────────────────
function nav(root, items, noneIfAbsent = false) {
  let current = root
  for (const k of items) {
    if (current === null || current === undefined) {
      if (noneIfAbsent) return null
      throw new Error(`Navigation failed: null at '${k}' in path ${JSON.stringify(items)}`)
    }
    current = current[k]
  }
  if (current === undefined) {
    return noneIfAbsent ? null : undefined
  }
  return current
}

function findObjectsByKey(objectList, key, nested = null) {
  const objects = []
  for (const item of objectList) {
    const target = nested ? item[nested] : item
    if (target && key in target) {
      objects.push(target)
    }
  }
  return objects
}

function findObjectByKey(objectList, key, nested = null, isKey = false) {
  for (const item of objectList) {
    const target = nested ? item[nested] : item
    if (target && key in target) {
      return isKey ? target[key] : target
    }
  }
  return null
}

// ─── Parser Utilities (ported from parsers/_utils.py) ───────────────────
function getFlexColumnItem(item, index) {
  if (!item || !item.flexColumns || item.flexColumns.length <= index) return null
  const col = item.flexColumns[index]
  if (!col || !col.musicResponsiveListItemFlexColumnRenderer) return null
  const renderer = col.musicResponsiveListItemFlexColumnRenderer
  if (!renderer.text || !renderer.text.runs) return null
  return renderer
}

function getItemText(item, index, runIndex = 0, noneIfAbsent = false) {
  const column = getFlexColumnItem(item, index)
  if (!column) return null
  const runs = column.text.runs
  if (noneIfAbsent && runs.length < runIndex + 1) return null
  return runs[runIndex] ? runs[runIndex].text : null
}

function getFixedColumnItem(item, index) {
  if (!item || !item.fixedColumns || !item.fixedColumns[index]) return null
  const renderer = item.fixedColumns[index].musicResponsiveListItemFixedColumnRenderer
  if (!renderer || !renderer.text || !renderer.text.runs) return null
  return renderer
}

function getDotSeparatorIndex(runs) {
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].text === DOT_SEPARATOR_RUN.text) return i
  }
  return runs.length
}

function parseDuration(duration) {
  if (!duration || !duration.trim()) return null
  const parts = duration.trim().split(':')
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
  }
  const multipliers = [1, 60, 3600]
  let seconds = 0
  for (let i = 0; i < parts.length; i++) {
    const multiplier = multipliers[parts.length - 1 - i] || 0
    seconds += multiplier * parseInt(parts[i], 10)
  }
  return seconds
}

function parseIdName(subRun) {
  return {
    id: nav(subRun, NAVIGATION_BROWSE_ID, true),
    name: nav(subRun, ['text'], true)
  }
}

// ─── Song Parsing (ported from parsers/songs.py, artists.py) ────────────
function parseArtistsRuns(runs) {
  const artists = []
  const count = Math.floor(runs.length / 2) + 1
  for (let j = 0; j < count; j++) {
    const idx = j * 2
    if (idx < runs.length) {
      artists.push({
        name: runs[idx].text,
        id: nav(runs[idx], NAVIGATION_BROWSE_ID, true)
      })
    }
  }
  return artists
}

function parseSongRun(run) {
  const text = run ? (run.text || '') : ''
  if (!text) return null

  if (run.navigationEndpoint) {
    const id = nav(run, NAVIGATION_BROWSE_ID, true)
    const item = { name: text, id }
    if (id && (id.startsWith('MPRE') || id.includes('release_detail'))) {
      return { type: 'album', data: item }
    }
    return { type: 'artist', data: item }
  }

  // Duration: N:N or N:N:N
  if (/^\d+:\d+(:\d+)?$/.test(text)) {
    return { type: 'duration', data: text }
  }

  // Year: exactly 4 digits
  if (/^\d{4}$/.test(text)) {
    return { type: 'year', data: text }
  }

  // Views: starts with digit, contains space (e.g. "1.4M views")
  if (/^\d[^ ]* [^ ]*$/.test(text)) {
    return { type: 'views', data: text.split(' ')[0] }
  }

  // Default: artist without id
  return { type: 'artist', data: { name: text, id: null } }
}

function parseSongRuns(runs, skipTypeSpec = false) {
  const parsed = {}

  // Prevent type specifier from being parsed as artist
  if (
    skipTypeSpec &&
    runs.length > 2 &&
    parseSongRun(runs[0]) && parseSongRun(runs[0]).type === 'artist' &&
    runs[1].text === DOT_SEPARATOR_RUN.text &&
    parseSongRun(runs[2]) && parseSongRun(runs[2]).type === 'artist'
  ) {
    runs = runs.slice(2)
  }

  for (let i = 0; i < runs.length; i++) {
    if (i % 2 === 1) continue // uneven items are separators

    const parsedRun = parseSongRun(runs[i])
    if (!parsedRun) continue

    const data = parsedRun.data
    switch (parsedRun.type) {
      case 'album':
        parsed.album = data
        break
      case 'artist':
        if (!parsed.artists) parsed.artists = []
        parsed.artists.push(data)
        break
      case 'views':
        parsed.views = data
        break
      case 'duration':
        parsed.duration = data
        parsed.duration_seconds = parseDuration(data)
        break
      case 'year':
        parsed.year = data
        break
    }
  }

  return parsed
}

function parseSongArtists(data, index) {
  const flexItem = getFlexColumnItem(data, index)
  if (!flexItem) return []
  return parseArtistsRuns(flexItem.text.runs)
}

function parseSongAlbum(data, index) {
  const flexItem = getFlexColumnItem(data, index)
  if (!flexItem) return null
  const browseId = nav(flexItem, [...TEXT_RUN, ...NAVIGATION_BROWSE_ID], true)
  return { name: getItemText(data, index), id: browseId }
}

// ─── Search Parsing (ported from parsers/search.py) ─────────────────────
const ALL_RESULT_TYPES = [
  'album', 'artist', 'playlist', 'song', 'video', 'station', 'profile', 'podcast', 'episode'
]

function getSearchResultType(resultTypeLocal, resultTypesLocal) {
  if (!resultTypeLocal) return null
  const lower = resultTypeLocal.toLowerCase()
  const idx = resultTypesLocal.indexOf(lower)
  if (idx === -1) return 'album' // default to album
  return ALL_RESULT_TYPES[idx]
}

function parseTopResult(data, searchResultTypes) {
  const resultType = getSearchResultType(nav(data, SUBTITLE, true) || '', searchResultTypes)
  const category = nav(data, ['header', 'musicCardShelfHeaderBasicRenderer', ...TITLE_TEXT], true) || 'Top result'
  const searchResult = { category, resultType }

  if (resultType === 'artist') {
    const subscribers = nav(data, SUBTITLE2, true)
    if (subscribers) searchResult.subscribers = subscribers.split(' ')[0]
    const artistInfo = parseSongRuns(nav(data, ['title', 'runs'], true) || [])
    Object.assign(searchResult, artistInfo)
  }

  if (resultType === 'song' || resultType === 'video') {
    const onTap = data.onTap
    if (onTap) {
      searchResult.videoId = nav(onTap, WATCH_VIDEO_ID, true)
      searchResult.videoType = nav(onTap, NAVIGATION_VIDEO_TYPE, true)
    }
  }

  if (resultType === 'song' || resultType === 'video' || resultType === 'album') {
    searchResult.videoId = nav(data, ['onTap', ...WATCH_VIDEO_ID], true)
    searchResult.videoType = nav(data, ['onTap', ...NAVIGATION_VIDEO_TYPE], true)
    searchResult.title = nav(data, TITLE_TEXT, true)
    const runs = nav(data, [...SUBTITLE_RUNS], true) || []
    if (runs.length > 2) {
      Object.assign(searchResult, parseSongRuns(runs.slice(2)))
    }
  }

  if (resultType === 'album') {
    searchResult.browseId = nav(data, [...TITLE, ...NAVIGATION_BROWSE_ID], true)
  }

  if (resultType === 'playlist') {
    searchResult.playlistId = nav(data, [...MENU_ITEMS, 0, MNIR, ...NAVIGATION_WATCH_PLAYLIST_ID], true)
    searchResult.title = nav(data, TITLE_TEXT, true)
    const runs = nav(data, [...SUBTITLE_RUNS], true) || []
    if (runs.length > 2) {
      searchResult.author = parseArtistsRuns(runs.slice(2))
    }
  }

  searchResult.thumbnails = nav(data, THUMBNAILS, true)
  return searchResult
}

function parseSearchResult(data, resultType, category) {
  const defaultOffset = (!resultType || resultType === 'album') ? 2 : 0
  const searchResult = { category }
  const videoType = nav(data, [...PLAY_BUTTON, 'playNavigationEndpoint', ...NAVIGATION_VIDEO_TYPE], true)

  // Determine result type based on browseId if no category
  if (!resultType) {
    const browseId = nav(data, NAVIGATION_BROWSE_ID, true)
    if (browseId) {
      const mapping = {
        VM: 'playlist', RD: 'playlist', VL: 'playlist',
        MPLA: 'artist', MPRE: 'album', MPSP: 'podcast', MPED: 'episode', UC: 'artist'
      }
      for (const [prefix, type] of Object.entries(mapping)) {
        if (browseId.startsWith(prefix)) {
          resultType = type
          break
        }
      }
    } else {
      resultType = videoType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song'
        : videoType === 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE' ? 'episode'
        : 'video'
    }
  }

  searchResult.resultType = resultType

  if (resultType !== 'artist') {
    searchResult.title = getItemText(data, 0)
  }

  if (resultType === 'artist') {
    searchResult.artist = getItemText(data, 0)
  } else if (resultType === 'album') {
    searchResult.type = getItemText(data, 1)
  } else if (resultType === 'playlist') {
    const flexItem = nav(getFlexColumnItem(data, 1), TEXT_RUNS, true)
    const hasAuthor = flexItem && flexItem.length === defaultOffset + 3
    if (flexItem) {
      const itemInfoText = (getItemText(data, 1, hasAuthor ? 2 : 0) || '').split(' ')
      if (itemInfoText.length >= 2 && itemInfoText[1] === 'songs') {
        searchResult.itemCount = itemInfoText[0]
      }
    }
    if (hasAuthor) searchResult.author = getItemText(data, 1, defaultOffset)
  } else if (resultType === 'song') {
    searchResult.album = null
  }

  // Extract videoId for playable types
  if (['song', 'video', 'episode'].includes(resultType)) {
    searchResult.videoId = nav(
      data, [...PLAY_BUTTON, 'playNavigationEndpoint', 'watchEndpoint', 'videoId'], true
    )
    searchResult.videoType = videoType
  }

  // Extract duration, year, artists, album
  if (['song', 'video', 'album'].includes(resultType)) {
    searchResult.duration = null
    searchResult.year = null
    const flexItem = getFlexColumnItem(data, 1)
    if (flexItem) {
      let runs = flexItem.text.runs
      const flexItem2 = getFlexColumnItem(data, 2)
      if (flexItem2) {
        runs = [...runs, { text: '' }, ...flexItem2.text.runs]
      }
      Object.assign(searchResult, parseSongRuns(runs, true))
    }
  }

  // Extract browseId for non-playable types
  if (['artist', 'album', 'playlist', 'profile', 'podcast'].includes(resultType)) {
    searchResult.browseId = nav(data, NAVIGATION_BROWSE_ID, true)
  }

  // Explicit badge
  if (['song', 'album'].includes(resultType)) {
    searchResult.isExplicit = nav(data, BADGE_LABEL, true) !== null
  }

  searchResult.thumbnails = nav(data, THUMBNAILS, true)
  return searchResult
}

function parseSearchResults(results, resultType, category) {
  return results
    .filter(r => r[MRLIR])
    .map(r => parseSearchResult(r[MRLIR], resultType, category))
}

function getSearchParams(filter, scope, ignoreSpelling) {
  const filteredParam1 = 'EgWKAQ'
  if (filter === null && scope === null && !ignoreSpelling) return null

  let params = null

  if (scope === 'uploads') {
    params = 'agIYAw%3D%3D'
  }

  if (scope === 'library') {
    if (filter) {
      const param2 = _getParam2(filter)
      return filteredParam1 + param2 + 'AWoKEAUQCRADEAoYBA%3D%3D'
    }
    params = 'agIYBA%3D%3D'
  }

  if (scope === null && filter) {
    if (filter === 'playlists') {
      params = 'Eg-KAQwIABAAGAAgACgB'
      params += ignoreSpelling
        ? 'MABCAggBagoQBBADEAkQBRAK'
        : 'MABqChAEEAMQCRAFEAo%3D'
    } else if (filter.includes('playlists')) {
      const param1 = 'EgeKAQQoA'
      const param2 = filter === 'featured_playlists' ? 'Dg' : 'EA'
      params = param1 + param2 + (ignoreSpelling
        ? 'BQgIIAWoMEA4QChADEAQQCRAF'
        : 'BagwQDhAKEAMQBBAJEAU%3D')
    } else {
      const param2 = _getParam2(filter)
      params = filteredParam1 + param2 + (ignoreSpelling
        ? 'AUICCAFqDBAOEAoQAxAEEAkQBQ%3D%3D'
        : 'AWoMEA4QChADEAQQCRAF')
    }
  }

  if (!scope && !filter && ignoreSpelling) {
    params = 'EhGKAQ4IARABGAEgASgAOAFAAUICCAE%3D'
  }

  return params
}

function _getParam2(filter) {
  const map = {
    songs: 'II', videos: 'IQ', albums: 'IY', artists: 'Ig',
    playlists: 'Io', profiles: 'JY', podcasts: 'JQ', episodes: 'JI'
  }
  return map[filter] || ''
}

// ─── Playlist Parsing (ported from parsers/playlists.py) ────────────────
function validatePlaylistId(playlistId) {
  return playlistId.startsWith('VL') ? playlistId.slice(2) : playlistId
}

function parsePlaylistItems(results, isAlbum = false) {
  const songs = []
  for (const result of results) {
    if (!result[MRLIR]) continue
    const song = parsePlaylistItem(result[MRLIR], isAlbum)
    if (song) songs.push(song)
  }
  return songs
}

function parsePlaylistItem(data, isAlbum = false) {
  let videoId = null
  let setVideoId = null

  // Find setVideoId and videoId from menu
  if (data.menu) {
    const menuItems = nav(data, MENU_ITEMS, true) || []
    for (const item of menuItems) {
      if (item.menuServiceItemRenderer) {
        const service = nav(item, MENU_SERVICE, true)
        if (service && service.playlistEditEndpoint) {
          setVideoId = nav(service, ['playlistEditEndpoint', 'actions', 0, 'setVideoId'], true)
          videoId = nav(service, ['playlistEditEndpoint', 'actions', 0, 'removedVideoId'], true)
        }
      }
    }
  }

  // Get videoId from play button
  const playButton = nav(data, PLAY_BUTTON, true)
  if (playButton && playButton.playNavigationEndpoint) {
    const watchEndpoint = playButton.playNavigationEndpoint.watchEndpoint
    if (watchEndpoint) {
      videoId = watchEndpoint.videoId
    }
  }

  // Determine column indices by checking navigation endpoints
  let titleIndex = isAlbum ? 0 : null
  let artistIndex = isAlbum ? 1 : null
  let albumIndex = isAlbum ? 2 : null
  let durationIndex = null

  for (let i = 0; i < (data.flexColumns || []).length; i++) {
    const flexItem = getFlexColumnItem(data, i)
    if (!flexItem) continue
    const navEndpoint = nav(flexItem, [...TEXT_RUN, 'navigationEndpoint'], true)

    if (!navEndpoint) {
      const run = nav(flexItem, TEXT_RUN, true)
      if (run && run.text) {
        const parsed = parseSongRun(run)
        if (parsed && parsed.type === 'duration') {
          durationIndex = i
        }
      }
      continue
    }

    if (navEndpoint.watchEndpoint) {
      titleIndex = i
    } else if (navEndpoint.browseEndpoint) {
      const pageType = nav(navEndpoint, PAGE_TYPE, true)
      if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || pageType === 'MUSIC_PAGE_TYPE_UNKNOWN') {
        artistIndex = i
      } else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' || pageType === 'MUSIC_PAGE_TYPE_AUDIOBOOK') {
        albumIndex = i
      } else if (pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
        if (artistIndex === null) artistIndex = i
      } else if (pageType === 'MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE') {
        titleIndex = i
      }
    }
  }

  const title = titleIndex !== null ? getItemText(data, titleIndex) : null
  if (!title || title === 'Song deleted') return null

  const artists = artistIndex !== null ? parseSongArtists(data, artistIndex) : null
  const album = albumIndex !== null ? parseSongAlbum(data, albumIndex) : null

  let duration = durationIndex !== null ? getItemText(data, durationIndex) : null
  // Duration may be in fixed columns
  if (data.fixedColumns && data.fixedColumns.length > 0) {
    const fixed = getFixedColumnItem(data, 0)
    if (fixed) {
      duration = nav(fixed, ['text', 'simpleText'], true) || nav(fixed, TEXT_RUN_TEXT, true)
    }
  }

  const thumbnails = nav(data, THUMBNAILS, true)

  const song = {
    videoId,
    title,
    artists: artists || [],
    album: album || null,
    duration: duration || null,
    duration_seconds: duration ? parseDuration(duration) : 0,
    thumbnails: thumbnails || []
  }

  if (setVideoId) song.setVideoId = setVideoId
  return song
}

// ─── Browse Parsing (ported from parsers/browsing.py) ───────────────────
function parsePlaylist(data) {
  const title = nav(data, TITLE_TEXT, true)
  const browseId = nav(data, [...TITLE, ...NAVIGATION_BROWSE_ID], true)
  const playlist = {
    title: title || '未知歌单',
    playlistId: browseId ? browseId.slice(2) : null,
    thumbnails: nav(data, THUMBNAIL_RENDERER, true)
  }
  const subtitle = data.subtitle
  if (subtitle && subtitle.runs) {
    playlist.description = subtitle.runs.map(r => r.text).join('')
    if (subtitle.runs.length === 3) {
      const sub2 = nav(data, SUBTITLE2, true)
      if (sub2 && /\d+ /.test(sub2)) {
        playlist.count = sub2.split(' ')[0]
        playlist.author = parseArtistsRuns(subtitle.runs.slice(0, 1))
      }
    }
  }
  return playlist
}

function parseContentList(results, parseFunc, key = MTRIR) {
  const contents = []
  for (const result of results) {
    if (result[key]) {
      contents.push(parseFunc(result[key]))
    }
  }
  return contents
}

// ─── Library Parsing (ported from parsers/library.py) ───────────────────
function getLibraryContents(response, renderer) {
  const section = nav(response, [...SINGLE_COLUMN_TAB, ...SECTION_LIST], true)
  if (section === null) {
    const numTabs = nav(response, [...SINGLE_COLUMN, 'tabs'], true)
    const tabCount = numTabs ? numTabs.length : 0
    const libTab = tabCount < 3 ? TAB_1_CONTENT : TAB_2_CONTENT
    return nav(response, [...SINGLE_COLUMN, ...libTab, ...SECTION_LIST_ITEM, ...renderer], true)
  }
  const results = findObjectByKey(section, 'itemSectionRenderer')
  if (results === null) {
    return nav(response, [...SINGLE_COLUMN_TAB, ...SECTION_LIST_ITEM, ...renderer], true)
  }
  return nav(results, [...ITEM_SECTION, ...renderer], true)
}

// ─── Watch/Lyrics Parsing (ported from parsers/watch.py) ────────────────
function getTabBrowseIds(watchNextRenderer) {
  const browseIds = {}
  const tabs = watchNextRenderer.tabs || []
  for (const tab of tabs) {
    if (!tab.tabRenderer || tab.tabRenderer.unselectable) continue
    const browseEndpoint = nav(tab, ['tabRenderer', 'endpoint', 'browseEndpoint'], true)
    if (browseEndpoint) {
      const pageType = nav(browseEndpoint, PAGE_TYPE, true)
      if (pageType) browseIds[pageType] = browseEndpoint.browseId
    }
  }
  return browseIds
}

// ─── Continuations (ported from continuations.py) ───────────────────────
function getContinuationToken(results) {
  if (!Array.isArray(results) || results.length === 0) return null
  const lastResult = results[results.length - 1]

  const token = nav(lastResult, CONTINUATION_TOKEN_PATH, true)
  if (token) return token

  const commands = nav(lastResult, COMMAND_EXECUTOR_COMMANDS, true) || []
  for (const command of commands) {
    if (nav(command, ['continuationCommand', 'request'], true) === 'CONTINUATION_REQUEST_TYPE_BROWSE') {
      return nav(command, ['continuationCommand', 'token'], true)
    }
  }
  return null
}

async function getContinuations2025(results, limit, requestFunc, parseFunc) {
  const items = []
  let contents = results.contents || results
  let continuationToken = getContinuationToken(contents)

  while (continuationToken && (limit === null || items.length < limit)) {
    const response = await requestFunc({ continuation: continuationToken })
    const continuationItems = nav(response, CONTINUATION_ITEMS, true)
    if (!continuationItems) break

    const newContents = parseFunc(continuationItems)
    if (newContents.length === 0) break
    items.push(...newContents)
    continuationToken = getContinuationToken(continuationItems)
  }

  return items
}

// Old-style continuations (ported from continuations.py get_continuations)
// Used by search (musicShelfContinuation) and library (gridContinuation)
async function getContinuationsOld(results, continuationType, limit, requestFunc, parseFunc) {
  const items = []
  let currentResults = results

  while (currentResults.continuations && (limit === null || items.length < limit)) {
    const ctoken = nav(currentResults, ['continuations', 0, 'nextContinuationData', 'continuation'], true)
    if (!ctoken) break

    const additionalParams = `&ctoken=${ctoken}&continuation=${ctoken}`
    const response = await requestFunc(additionalParams)

    if (!response.continuationContents || !response.continuationContents[continuationType]) break
    currentResults = response.continuationContents[continuationType]

    // Parse contents from continuation
    let contents = null
    if (currentResults.contents) contents = currentResults.contents
    else if (currentResults.items) contents = currentResults.items
    if (!contents || contents.length === 0) break

    items.push(...parseFunc(contents))
  }

  return items
}

// ─── Plugin State ───────────────────────────────────────────────────────
let pluginContext = null
let innertubeConfig = null
let playerCache = null
let proxyServer = null
let proxyPort = 0
const proxyTokens = new Map()
const streamUrlCache = new Map()
const playlistTrackCache = new Map()

// OAuth state
let oauthToken = null // { access_token, refresh_token, expires_at, scope, token_type }
let oauthDeviceFlow = null // { device_code, user_code, verification_url, expires_at, interval }
let oauthClient = null // { client_id, client_secret } — auto-discovered from YouTube TV

// ─── Plugin Lifecycle ───────────────────────────────────────────────────
export async function activate(context) {
  pluginContext = context
  context.logger.info('Registering YouTube Music provider')

  // Load stored OAuth token (auto-refresh if expiring)
  try {
    const storedToken = await context.settings.get(SETTINGS_OAUTH_TOKEN_KEY)
    if (storedToken && typeof storedToken === 'object' && storedToken.access_token) {
      oauthToken = storedToken
      await ensureFreshOAuthToken()
    }
  } catch (err) {
    context.logger?.warn?.(`Failed to load OAuth state: ${errorToMessage(err)}`)
  }

  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: 'YouTube Music',
    capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'],
    ui: {
      icon: 'pi pi-youtube',
      color: '#FF0000',
      description: '谷歌音乐流媒体',
      authType: 'oauth',
      loginInstructions: '请在浏览器中登录 Google 账号并授权',
      qrStatusCodes: { waiting: -2, scanned: null, expired: -3, denied: -4, success: 0 },
      showBrowserButton: true,
      streamingLibraryTab: true,
      streamingSearch: true,
      unifiedLibrary: true
    },
    searchSongs,
    getPlaybackUrl,
    getLyrics,
    fetchPlaylistTracks,
    fetchUserLibrary,
    checkLogin,
    getProfile,
    logout,
    getQrLogin,
    checkQrLogin
  })

  await context.twilight.ui.register({
    id: 'ytmusic-settings',
    kind: 'settingsPanel',
    title: 'YouTube Music 账号',
    description: '导入浏览器 Cookie 以启用 YouTube Music 搜索与播放'
  })
}

export async function deactivate() {
  proxyTokens.clear()
  streamUrlCache.clear()
  playlistTrackCache.clear()
  innertubeConfig = null
  playerCache = null
  oauthToken = null
  oauthDeviceFlow = null
  oauthClient = null
  if (proxyServer) {
    await new Promise((resolve) => proxyServer.close(resolve))
    proxyServer = null
    proxyPort = 0
  }
  pluginContext = null
}

// ─── Settings Helpers ───────────────────────────────────────────────────
function getContext() {
  if (!pluginContext) throw new Error('YouTube Music provider is not active')
  return pluginContext
}

async function getCookie() {
  const value = await getContext().settings.get(SETTINGS_COOKIE_KEY)
  return typeof value === 'string' ? value : ''
}

async function saveCookie(cookie) {
  if (cookie) {
    await getContext().settings.set(SETTINGS_COOKIE_KEY, cookie)
  } else {
    await getContext().settings.delete(SETTINGS_COOKIE_KEY)
  }
}

async function getStoredInnertube() {
  const value = await getContext().settings.get(SETTINGS_INNERTUBE_KEY)
  return value && typeof value === 'object' ? value : null
}

async function saveInnertube(config) {
  await getContext().settings.set(SETTINGS_INNERTUBE_KEY, config)
}

// ─── InnerTube Initialization (ported from helpers.py) ──────────────────
function getDynamicClientVersion() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `1.${y}${m}${d}.01.00`
}

function extractYtcfg(html) {
  const marker = 'ytcfg.set('
  const start = html.indexOf(marker)
  if (start === -1) return null

  // Find matching closing paren by counting braces
  let braceStart = html.indexOf('{', start)
  if (braceStart === -1) return null

  let depth = 0
  let braceEnd = -1
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) {
        braceEnd = i
        break
      }
    }
  }
  if (braceEnd === -1) return null

  try {
    return JSON.parse(html.slice(braceStart, braceEnd + 1))
  } catch {
    return null
  }
}

async function ensureInnertubeConfig() {
  if (innertubeConfig) return innertubeConfig

  // Try cached config
  const stored = await getStoredInnertube()
  if (stored && stored.apiKey && stored.clientVersion) {
    innertubeConfig = stored
    return innertubeConfig
  }

  // Default config with dynamic version
  innertubeConfig = {
    apiKey: HARDCODED_API_KEY,
    clientName: 'WEB_REMIX',
    clientVersion: getDynamicClientVersion(),
    visitorData: ''
  }

  // Try to scrape from homepage for better accuracy
  try {
    const cookie = await getCookie()
    const response = await fetchWithTimeout(`${YTM_DOMAIN}/`, { headers: defaultHeaders(cookie) })
    const html = await response.text()
    const ytcfg = extractYtcfg(html)

    if (ytcfg) {
      if (ytcfg.INNERTUBE_API_KEY) innertubeConfig.apiKey = ytcfg.INNERTUBE_API_KEY
      if (ytcfg.INNERTUBE_CONTEXT?.client?.clientVersion) {
        innertubeConfig.clientVersion = ytcfg.INNERTUBE_CONTEXT.client.clientVersion
      }
      const visitorData = ytcfg.VISITOR_DATA || ytcfg.INNERTUBE_CONTEXT?.client?.visitorData
      if (visitorData) innertubeConfig.visitorData = visitorData
    }
  } catch (err) {
    logWarn(`Failed to scrape InnerTube config from homepage: ${errorToMessage(err)}`)
  }

  await saveInnertube(innertubeConfig)
  return innertubeConfig
}

function buildInnerTubeContext() {
  return {
    context: {
      capabilities: {},
      client: {
        clientName: innertubeConfig.clientName,
        clientVersion: innertubeConfig.clientVersion,
        experimentIds: [],
        experimentsToken: '',
        gl: 'US',
        hl: 'zh-CN',
        visitorData: innertubeConfig.visitorData || undefined
      },
      user: {}
    }
  }
}

// ─── InnerTube API Calls ────────────────────────────────────────────────
async function innertubePost(endpoint, body = {}, usePlayerBase = false, additionalParams = '') {
  const config = await ensureInnertubeConfig()
  const cookie = await getCookie()
  const base = usePlayerBase ? YT_PLAYER_BASE : YTM_API_BASE
  let url = `${base}/${endpoint}?alt=json&key=${encodeURIComponent(config.apiKey)}`
  if (additionalParams) url += additionalParams

  const headers = {
    ...defaultHeaders(cookie),
    'Content-Type': 'application/json',
    'X-Goog-Visitor-Id': config.visitorData || '',
    'X-YouTube-Client-Name': '67',
    'X-YouTube-Client-Version': config.clientVersion,
    'X-YouTube-Utc-Offset': String(-new Date().getTimezoneOffset()),
    'X-YouTube-Time-Zone': 'Asia/Shanghai',
    Origin: YTM_DOMAIN,
    'X-Origin': YTM_DOMAIN
  }

  // Add SAPISIDHASH authorization if we have a SAPISID cookie
  const sapisid = getSapisid(cookie)
  if (sapisid) {
    headers.Authorization = getAuthorization(sapisid, YTM_DOMAIN)
  }

  // Use OAuth Bearer token if available (takes precedence over SAPISIDHASH)
  if (oauthToken && oauthToken.access_token) {
    headers.Authorization = `Bearer ${oauthToken.access_token}`
    headers['X-Goog-Request-Time'] = String(Math.floor(Date.now() / 1000))
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...buildInnerTubeContext(), ...body })
  })

  if (!response.ok) {
    throw new Error(`YouTube Music API request failed: HTTP ${response.status}`)
  }

  return response.json()
}

// ─── Search Implementation (ported from mixins/search.py) ───────────────
async function searchSongs(keywords, limit = 30, offset = 0) {
  // Use 'songs' filter to get song-only results with continuation support
  // This allows fetching more results than the default unfiltered search (~6-10 items)
  const params = getSearchParams('songs', null, false)
  const body = { query: keywords, params }
  const endpoint = 'search'
  const response = await innertubePost(endpoint, body)

  if (!response.contents) {
    return { items: [], total: 0 }
  }

  const tabbedSearch = response.contents.tabbedSearchResultsRenderer
  if (!tabbedSearch || !tabbedSearch.tabs || tabbedSearch.tabs.length === 0) {
    return { items: [], total: 0 }
  }

  // With filter, use tab index 0
  const tabContent = tabbedSearch.tabs[0].tabRenderer?.content
  if (!tabContent) return { items: [], total: 0 }

  const sectionList = nav(tabContent, SECTION_LIST, true)
  if (!sectionList) return { items: [], total: 0 }

  // No results check
  if (sectionList.length === 1 && 'itemSectionRenderer' in sectionList[0]) {
    return { items: [], total: 0 }
  }

  const allResults = []
  let searchShelfRenderer = null

  for (const res of sectionList) {
    if (res.musicShelfRenderer) {
      searchShelfRenderer = res.musicShelfRenderer
      const category = nav(res, [...MUSIC_SHELF, ...TITLE_TEXT], true)
      const contents = res.musicShelfRenderer.contents || []
      try {
        allResults.push(...parseSearchResults(contents, 'song', category))
      } catch (err) {
        logWarn(`Failed to parse search results: ${errorToMessage(err)}`)
      }
    }
  }

  // Fetch more results via old-style continuations if needed
  if (searchShelfRenderer && allResults.length < offset + limit) {
    try {
      const requestFunc = async (additionalParams) => {
        return innertubePost(endpoint, body, false, additionalParams)
      }
      const parseFunc = (contents) => parseSearchResults(contents, 'song', null)
      const remaining = offset + limit - allResults.length
      const continuationResults = await getContinuationsOld(
        searchShelfRenderer, 'musicShelfContinuation', remaining, requestFunc, parseFunc
      )
      allResults.push(...continuationResults)
    } catch (err) {
      logWarn(`Search continuation failed: ${errorToMessage(err)}`)
    }
  }

  // Filter to only playable results (songs and videos)
  const playableResults = allResults.filter(
    r => r.resultType === 'song' || r.resultType === 'video'
  )

  const total = playableResults.length
  const paged = playableResults.slice(offset, offset + limit)

  return {
    items: paged.map(normalizeTrack).filter(Boolean),
    total
  }
}

// ─── Playback URL ───────────────────────────────────────────────────────
async function getPlaybackUrl(track) {
  const videoId = extractVideoId(track)
  if (!videoId) throw new Error('YouTube Music track ID invalid')

  // Check cache
  const cacheKey = videoId
  if (streamUrlCache.has(cacheKey)) {
    const cached = streamUrlCache.get(cacheKey)
    if (Date.now() < cached.expiresAt) return cached.url
    streamUrlCache.delete(cacheKey)
  }

  const cookie = await getCookie()
  const playerData = await innertubePost(
    'player',
    {
      videoId,
      playbackContext: {
        contentPlaybackContext: { signatureTimestamp: playerCache?.sts || 0 }
      }
    },
    true
  )

  const streamingData = playerData?.streamingData
  if (!streamingData) {
    throw new Error('YouTube Music returned no streaming data (Premium may be required)')
  }

  const allFormats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || [])
  ]

  const audioFormats = allFormats.filter(f => f.mimeType && f.mimeType.startsWith('audio/'))
  if (audioFormats.length === 0) {
    throw new Error('YouTube Music returned no audio streams')
  }

  // Sort by preferred itag, then by bitrate
  audioFormats.sort((a, b) => {
    const aIdx = PREFERRED_AUDIO_ITAGS.indexOf(a.itag)
    const bIdx = PREFERRED_AUDIO_ITAGS.indexOf(b.itag)
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
    if (aIdx !== -1) return -1
    if (bIdx !== -1) return 1
    return (b.bitrate || 0) - (a.bitrate || 0)
  })

  const format = audioFormats[0]
  let streamUrl = format.url

  // If URL needs deciphering
  if (!streamUrl && (format.signatureCipher || format.cipher)) {
    streamUrl = await decipherSignature(format.signatureCipher || format.cipher)
  }

  if (!streamUrl) {
    throw new Error('YouTube Music audio stream URL resolution failed')
  }

  // Handle n-parameter throttling
  streamUrl = await transformNParam(streamUrl)

  // Proxy through local server
  await ensureProxyServer()
  const token = createProxyToken(
    { kind: 'stream', url: streamUrl, cookie, contentType: getContentType(format) },
    STREAM_PROXY_TOKEN_TTL_MS
  )

  const proxyUrl = `http://127.0.0.1:${proxyPort}/stream/${token}`
  streamUrlCache.set(cacheKey, { url: proxyUrl, expiresAt: Date.now() + STREAM_PROXY_TOKEN_TTL_MS })

  logInfo(`YouTube Music stream selected: itag=${format.itag} ${format.mimeType}`)
  return proxyUrl
}

// ─── Signature Deciphering ──────────────────────────────────────────────
async function ensurePlayer() {
  if (playerCache) return playerCache

  try {
    const response = await fetchWithTimeout(`${YT_BASE}/iframe_api`, { headers: defaultHeaders('') })
    const js = await response.text()

    // Extract player ID: player/ID/
    const playerMatch = js.match(/player\/([^/]+)\//)
    if (!playerMatch) return null

    const playerId = playerMatch[1]
    const playerUrl = `${YT_BASE}/s/player/${playerId}/player_ias.vflset/en_US/base.js`
    const playerRes = await fetchWithTimeout(playerUrl, { headers: defaultHeaders('') })
    const playerJs = await playerRes.text()

    // Extract signature timestamp
    const stsMatch = playerJs.match(/signatureTimestamp:(\d+)/)
    const sts = stsMatch ? parseInt(stsMatch[1], 10) : 0

    const decipherFn = extractDecipherFunction(playerJs)
    const nParamFn = extractNParamFunction(playerJs)

    playerCache = { playerId, sts, decipherFn, nParamFn, playerJs }
    return playerCache
  } catch (err) {
    logWarn(`Failed to load YouTube player: ${errorToMessage(err)}`)
    return null
  }
}

function extractDecipherFunction(playerJs) {
  // Find: a.set("signature", FUNCNAME(
  const marker = 'a.set("signature",'
  const markerIdx = playerJs.indexOf(marker)
  if (markerIdx === -1) return null

  // Extract function name
  let i = markerIdx + marker.length
  while (i < playerJs.length && playerJs[i] === ' ') i++
  let funcName = ''
  while (i < playerJs.length && /[a-zA-Z0-9_$]/.test(playerJs[i])) {
    funcName += playerJs[i]
    i++
  }
  if (!funcName) return null

  // Find function definition: funcName=function(params){body}
  const funcDefMarker = funcName + '=function('
  const funcDefIdx = playerJs.indexOf(funcDefMarker)
  if (funcDefIdx === -1) return null

  // Extract params
  const paramsStart = funcDefIdx + funcDefMarker.length - 1
  let paramsEnd = paramsStart + 1
  while (paramsEnd < playerJs.length && playerJs[paramsEnd] !== ')') paramsEnd++
  const params = playerJs.slice(paramsStart + 1, paramsEnd)

  // Extract body (find matching closing brace)
  let bodyStart = paramsEnd + 1
  while (bodyStart < playerJs.length && playerJs[bodyStart] !== '{') bodyStart++
  let depth = 0
  let bodyEnd = bodyStart
  for (let j = bodyStart; j < playerJs.length; j++) {
    if (playerJs[j] === '{') depth++
    else if (playerJs[j] === '}') {
      depth--
      if (depth === 0) { bodyEnd = j; break }
    }
  }
  const body = playerJs.slice(bodyStart + 1, bodyEnd)

  // Find helper object (contains reverse, slice, swap methods)
  let helperCode = null
  const helperSearchArea = playerJs.slice(
    Math.max(0, funcDefIdx - 10000),
    funcDefIdx + 10000
  )
  const helperOffset = Math.max(0, funcDefIdx - 10000)

  // Search for: var NAME={...reverse:function...};
  const varMarker = 'var '
  for (let k = 0; k < helperSearchArea.length - varMarker.length; k++) {
    if (helperSearchArea.slice(k, k + varMarker.length) === varMarker) {
      const chunk = helperSearchArea.slice(k, k + 500)
      if (chunk.includes('reverse:function')) {
        // Find the var name
        let nameEnd = k + varMarker.length
        while (nameEnd < helperSearchArea.length && /[a-zA-Z0-9_$]/.test(helperSearchArea[nameEnd])) {
          nameEnd++
        }
        // Find the end of the var declaration (matching closing brace + semicolon)
        const braceStart = helperSearchArea.indexOf('{', k)
        if (braceStart !== -1) {
          let d = 0
          let braceEnd = braceStart
          for (let j = braceStart; j < helperSearchArea.length; j++) {
            if (helperSearchArea[j] === '{') d++
            else if (helperSearchArea[j] === '}') {
              d--
              if (d === 0) { braceEnd = j; break }
            }
          }
          helperCode = playerJs.slice(helperOffset + k, helperOffset + braceEnd + 1)
        }
        break
      }
    }
  }

  return { funcName, params, body, helperCode }
}

function extractNParamFunction(playerJs) {
  // The n-parameter function is typically referenced near: b=a.get("n")
  const marker = 'b=a.get("n")'
  const markerIdx = playerJs.indexOf(marker)
  if (markerIdx === -1) return null

  // Find the function call after the marker
  const searchArea = playerJs.slice(markerIdx, markerIdx + 200)
  // Look for: var RESULT=FUNCNAME(b) or RESULT=FUNCNAME(b)
  const callMatch = searchArea.match(/=([a-zA-Z0-9_$]+)\(b\)/)
  if (!callMatch) return null

  const funcName = callMatch[1]

  // Find function definition: function funcName(params){body}
  // or: var funcName=function(params){body}
  // or: funcName=function(params){body}
  const patterns = [
    `function ${funcName}(`,
    `${funcName}=function(`,
    `var ${funcName}=function(`
  ]

  let funcDefIdx = -1
  for (const pattern of patterns) {
    funcDefIdx = playerJs.indexOf(pattern)
    if (funcDefIdx !== -1) break
  }
  if (funcDefIdx === -1) return null

  // Extract params
  const paramsStart = playerJs.indexOf('(', funcDefIdx)
  if (paramsStart === -1) return null
  let paramsEnd = paramsStart + 1
  while (paramsEnd < playerJs.length && playerJs[paramsEnd] !== ')') paramsEnd++
  const params = playerJs.slice(paramsStart + 1, paramsEnd)

  // Extract body
  let bodyStart = paramsEnd + 1
  while (bodyStart < playerJs.length && playerJs[bodyStart] !== '{') bodyStart++
  let depth = 0
  let bodyEnd = bodyStart
  for (let j = bodyStart; j < playerJs.length; j++) {
    if (playerJs[j] === '{') depth++
    else if (playerJs[j] === '}') {
      depth--
      if (depth === 0) { bodyEnd = j; break }
    }
  }
  const body = playerJs.slice(bodyStart + 1, bodyEnd)

  return { funcName, params, body }
}

async function decipherSignature(signatureCipher) {
  const params = new URLSearchParams(signatureCipher)
  const s = params.get('s')
  const url = params.get('url')
  if (!s || !url) return null

  const player = await ensurePlayer()
  if (!player?.decipherFn) return url

  try {
    const { decipherFn } = player
    let code = ''
    if (decipherFn.helperCode) code += decipherFn.helperCode + '\n'
    code += `function ${decipherFn.funcName}(${decipherFn.params}) {\n${decipherFn.body}\n}`
    code += `\n${decipherFn.funcName}(${JSON.stringify(s)});`

    const result = runInNewContext(code, {}, { timeout: 5000 })
    return `${url}&sig=${encodeURIComponent(result)}`
  } catch (err) {
    logWarn(`Signature decipher failed: ${errorToMessage(err)}`)
    return url
  }
}

async function transformNParam(streamUrl) {
  const player = await ensurePlayer()
  if (!player?.nParamFn) return streamUrl

  try {
    const url = new URL(streamUrl)
    const n = url.searchParams.get('n')
    if (!n) return streamUrl

    const { nParamFn } = player
    const code = `function ${nParamFn.funcName}(${nParamFn.params}) {\n${nParamFn.body}\n}\n${nParamFn.funcName}(${JSON.stringify(n)});`

    const transformed = runInNewContext(code, {}, { timeout: 5000 })
    if (typeof transformed === 'string' && transformed) {
      url.searchParams.set('n', transformed)
      return url.toString()
    }
  } catch (err) {
    logWarn(`N-param transform failed: ${errorToMessage(err)}`)
  }

  return streamUrl
}

// ─── Lyrics (ported from mixins/watch.py) ───────────────────────────────
async function getLyrics(track) {
  const videoId = extractVideoId(track)
  if (!videoId) return { lyrics: null, translatedLyrics: null }

  try {
    // Step 1: Get watch next data to find lyrics browseId
    const nextData = await innertubePost('next', {
      videoId,
      enablePersistentPlaylistPanel: true,
      isAudioOnly: true,
      tunerSettingValue: 'AUTOMIX_SETTING_NORMAL'
    })

    const watchNextRenderer = nav(nextData, [
      'contents', 'singleColumnMusicWatchNextResultsRenderer',
      'tabbedRenderer', 'watchNextTabbedResultsRenderer'
    ], true)

    if (!watchNextRenderer) return { lyrics: null, translatedLyrics: null }

    const browseIds = getTabBrowseIds(watchNextRenderer)
    const lyricsBrowseId = browseIds['MUSIC_PAGE_TYPE_TRACK_LYRICS']
    if (!lyricsBrowseId) return { lyrics: null, translatedLyrics: null }

    // Step 2: Browse lyrics
    const lyricsData = await innertubePost('browse', { browseId: lyricsBrowseId })
    const lyricsText = extractLyricsText(lyricsData)

    return { lyrics: lyricsText, translatedLyrics: null }
  } catch (err) {
    logWarn(`YouTube Music lyrics fetch failed: ${errorToMessage(err)}`)
    return { lyrics: null, translatedLyrics: null }
  }
}

function extractLyricsText(data) {
  const sections = nav(data, [...SECTION_LIST], true)
  if (!Array.isArray(sections)) return null

  for (const section of sections) {
    const descShelf = section[DESCRIPTION_SHELF[0]]
    if (descShelf && descShelf.description && descShelf.description.runs) {
      return descShelf.description.runs.map(r => r.text).join('')
    }
  }
  return null
}

// ─── Library & Playlists (ported from mixins/library.py, playlists.py) ──
async function fetchUserLibrary() {
  const cookie = await getCookie()
  if (!cookie && !oauthToken) throw new Error('Please login to YouTube Music first')

  const data = await innertubePost('browse', { browseId: 'FEmusic_liked_playlists' })

  const results = getLibraryContents(data, GRID)
  if (!results || !results.items) {
    return { likedPlaylist: null, playlists: [] }
  }

  // Skip first item (Create playlist button)
  const playlists = parseContentList(results.items.slice(1), parsePlaylist)

  // Fetch more playlists via old-style grid continuations
  const endpoint = 'browse'
  const body = { browseId: 'FEmusic_liked_playlists' }
  try {
    const requestFunc = async (additionalParams) => innertubePost(endpoint, body, false, additionalParams)
    const parseFunc = (contents) => parseContentList(contents, parsePlaylist)
    const continuationPlaylists = await getContinuationsOld(
      results, 'gridContinuation', null, requestFunc, parseFunc
    )
    playlists.push(...continuationPlaylists)
  } catch (err) {
    logWarn(`Library continuation failed: ${errorToMessage(err)}`)
  }

  // Find liked music playlist
  const likedPlaylist = playlists.find(p => p.playlistId === 'LM') || playlists[0] || null

  return {
    likedPlaylist,
    playlists: playlists.map(p => ({
      id: p.playlistId,
      name: p.title,
      cover: p.thumbnails && p.thumbnails.length > 0
        ? p.thumbnails[p.thumbnails.length - 1].url
        : null,
      trackCount: p.count ? parseInt(p.count, 10) : 0
    }))
  }
}

async function fetchPlaylistTracks(playlistId, force = false) {
  const cacheKey = String(playlistId)
  if (!force && playlistTrackCache.has(cacheKey)) {
    return playlistTrackCache.get(cacheKey)
  }

  const cookie = await getCookie()
  if (!cookie && !oauthToken) throw new Error('Please login to YouTube Music first')

  const tracks = []
  const validatedId = validatePlaylistId(playlistId)
  const browseId = playlistId === 'LM' ? 'LM' : `VL${validatedId}`

  // First request
  const data = await innertubePost('browse', { browseId })

  // Try new two-column structure first, then old single-column
  let contentData = nav(data, [...TWO_COLUMN_RENDERER, 'secondaryContents', ...SECTION, ...CONTENT, 'musicPlaylistShelfRenderer'], true)

  if (!contentData) {
    // Old structure: singleColumnBrowseResultsRenderer
    contentData = nav(data, [...SINGLE_COLUMN_TAB, ...SECTION_LIST_ITEM, 'musicPlaylistShelfRenderer'], true)
  }

  if (!contentData) {
    // Try musicShelfRenderer (for liked songs)
    contentData = nav(data, [...SINGLE_COLUMN_TAB, ...SECTION_LIST_ITEM, ...MUSIC_SHELF], true)
  }

  if (!contentData) {
    playlistTrackCache.set(cacheKey, tracks)
    return tracks
  }

  // Parse initial tracks
  if (contentData.contents) {
    tracks.push(...parsePlaylistItems(contentData.contents))
  }

  // Fetch continuations
  const requestFunc = async (body) => innertubePost('browse', body)
  const parseFunc = (contents) => parsePlaylistItems(contents)

  try {
    const continuationTracks = await getContinuations2025(
      contentData,
      500,
      requestFunc,
      parseFunc
    )
    tracks.push(...continuationTracks)
  } catch (err) {
    logWarn(`Continuation fetch failed: ${errorToMessage(err)}`)
  }

  const normalizedTracks = tracks.map(normalizeTrack)
  playlistTrackCache.set(cacheKey, normalizedTracks)
  return normalizedTracks
}

// ─── Login / Auth ───────────────────────────────────────────────────────
// Supports two auth modes:
// 1. OAuth 2.0 Device Code Grant (browser auth) — primary
// 2. Cookie import (SAPISIDHASH) — fallback

async function checkLogin() {
  // Check OAuth token first
  if (oauthToken && oauthToken.access_token) {
    await ensureFreshOAuthToken()
    if (oauthToken && oauthToken.access_token) {
      try {
        const profile = await fetchAccountInfo()
        if (profile) return { loggedIn: true, profile }
      } catch {
        // Token might be invalid, fall through to cookie check
      }
    }
  }

  // Check cookie-based auth
  const cookie = await getCookie()
  if (!cookie) return { loggedIn: false, profile: null }

  try {
    const profile = await fetchAccountInfo()
    if (profile) return { loggedIn: true, profile }

    if (cookie.includes('SAPISID=') || cookie.includes('__Secure-3PAPISID=')) {
      return { loggedIn: true, profile: { nickname: 'YouTube Music 用户', userId: '', avatarUrl: '' } }
    }
    return { loggedIn: false, profile: null }
  } catch {
    if (cookie.includes('SAPISID=') || cookie.includes('__Secure-3PAPISID=')) {
      return { loggedIn: true, profile: { nickname: 'YouTube Music 用户', userId: '', avatarUrl: '' } }
    }
    return { loggedIn: false, profile: null }
  }
}

async function fetchAccountInfo() {
  const data = await innertubePost('account/account_menu', {})

  const ACCOUNT_INFO = [
    'actions', 0, 'openPopupAction', 'popup',
    'multiPageMenuRenderer', 'header', 'activeAccountHeaderRenderer'
  ]
  const ACCOUNT_RUNS_TEXT = ['runs', 0, 'text']
  const ACCOUNT_NAME = [...ACCOUNT_INFO, 'accountName', ...ACCOUNT_RUNS_TEXT]
  const ACCOUNT_CHANNEL_HANDLE = [...ACCOUNT_INFO, 'channelHandle', ...ACCOUNT_RUNS_TEXT]
  const ACCOUNT_PHOTO_URL = [...ACCOUNT_INFO, 'accountPhoto', 'thumbnails', 0, 'url']

  const name = nav(data, ACCOUNT_NAME, true)
  if (name) {
    const handle = nav(data, ACCOUNT_CHANNEL_HANDLE, true)
    const photo = nav(data, ACCOUNT_PHOTO_URL, true)
    return { nickname: name, userId: handle || '', avatarUrl: photo }
  }
  return null
}

async function getProfile() {
  const login = await checkLogin()
  return login.profile
}

async function logout() {
  await saveCookie('')
  await getContext().settings.delete(SETTINGS_INNERTUBE_KEY)
  await getContext().settings.delete(SETTINGS_OAUTH_TOKEN_KEY)
  oauthToken = null
  oauthDeviceFlow = null
  oauthClient = null
  innertubeConfig = null
  playerCache = null
  streamUrlCache.clear()
  playlistTrackCache.clear()
}

// ─── OAuth 2.0 Device Code Grant ────────────────────────────────────────
// Auto-discovers client credentials from YouTube TV page (no user config needed).
// Approach ported from youtubei.js (LuanRT/YouTube.js) OAuth2.ts.
// Flow: discoverClient → get_device_code → user visits URL → poll token → store

// Step 0: Auto-discover OAuth client_id/secret from YouTube TV page
async function discoverOAuthClient() {
  if (oauthClient) return oauthClient

  // Fetch YouTube TV page
  const tvResponse = await fetchWithTimeout(YTTV_URL, {
    headers: {
      'User-Agent': YTTV_UA,
      Referer: 'https://www.youtube.com/tv',
      'Accept-Language': 'en-US'
    }
  })
  if (!tvResponse.ok) {
    throw new Error(`YouTube TV page request failed: HTTP ${tvResponse.status}`)
  }
  const tvHtml = await tvResponse.text()

  // Extract script URL: <script id="base-js" src="...">
  const scriptMatch = tvHtml.match(/<script\s+id="base-js"\s+src="([^"]+)"/)
  if (!scriptMatch) {
    throw new Error('Could not find YouTube TV base.js script URL')
  }
  const scriptUrl = scriptMatch[1].startsWith('http')
    ? scriptMatch[1]
    : `${YT_BASE}${scriptMatch[1]}`

  // Download the script
  const scriptResponse = await fetchWithTimeout(scriptUrl, {
    headers: { 'User-Agent': YTTV_UA }
  })
  if (!scriptResponse.ok) {
    throw new Error(`YouTube TV script download failed: HTTP ${scriptResponse.status}`)
  }
  const scriptText = await scriptResponse.text()

  // Extract client_id and client_secret: clientId:"...",...:"..."
  const clientMatch = scriptText.match(/clientId:"([^"]+)",[^:]*?:"([^"]+)"/)
  if (!clientMatch) {
    throw new Error('Could not extract OAuth client credentials from YouTube TV script')
  }

  oauthClient = {
    client_id: clientMatch[1],
    client_secret: clientMatch[2]
  }

  logInfo('YouTube Music OAuth client discovered from YouTube TV')
  return oauthClient
}

async function getQrLogin() {
  // Auto-discover OAuth client credentials (no user config needed)
  const client = await discoverOAuthClient()

  // Request device code
  const codeResponse = await fetchWithTimeout(OAUTH_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': YTTV_UA
    },
    body: JSON.stringify({
      client_id: client.client_id,
      scope: OAUTH_SCOPE
    })
  })

  if (!codeResponse.ok) {
    const errText = await codeResponse.text().catch(() => '')
    throw new Error(`YouTube Music OAuth device code failed: HTTP ${codeResponse.status} ${errText}`)
  }

  const codeData = await codeResponse.json()
  // { device_code, user_code, expires_in, interval, verification_url }

  oauthDeviceFlow = {
    device_code: codeData.device_code,
    user_code: codeData.user_code,
    verification_url: codeData.verification_url,
    expires_at: Date.now() + (codeData.expires_in || 1800) * 1000,
    interval: (codeData.interval || 5) * 1000
  }

  // Build the URL the user should visit
  const authUrl = `${codeData.verification_url}?user_code=${codeData.user_code}`

  return {
    key: codeData.device_code,
    qrContent: authUrl,
    expiresInSeconds: codeData.expires_in || 1800
  }
}

async function checkQrLogin(key) {
  if (!oauthDeviceFlow) {
    return { code: -1, message: '未发起 OAuth 登录流程' }
  }

  // Check if device code expired
  if (Date.now() >= oauthDeviceFlow.expires_at) {
    oauthDeviceFlow = null
    return { code: -3, message: '授权码已过期，请重新登录' }
  }

  // Verify the key matches
  if (key && key !== oauthDeviceFlow.device_code) {
    return { code: -1, message: '设备码不匹配' }
  }

  const client = oauthClient || await discoverOAuthClient().catch(() => null)
  if (!client) {
    return { code: -1, message: '无法获取 OAuth 客户端凭据' }
  }

  try {
    const tokenResponse = await fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YTTV_UA
      },
      body: JSON.stringify({
        client_id: client.client_id,
        client_secret: client.client_secret,
        grant_type: 'http://oauth.net/grant_type/device/1.0',
        code: oauthDeviceFlow.device_code
      })
    })

    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok || tokenData.error) {
      const error = tokenData.error
      if (error === 'authorization_pending') {
        return { code: -2, message: '等待用户在浏览器中授权...' }
      }
      if (error === 'slow_down') {
        return { code: -2, message: '请稍候...' }
      }
      if (error === 'expired_token') {
        oauthDeviceFlow = null
        return { code: -3, message: '授权码已过期，请重新登录' }
      }
      if (error === 'access_denied') {
        oauthDeviceFlow = null
        return { code: -4, message: '用户拒绝了授权' }
      }
      return { code: -1, message: `OAuth 错误: ${error || '未知错误'}` }
    }

    // Success — store the token
    oauthToken = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      scope: tokenData.scope,
      token_type: tokenData.token_type
    }

    await getContext().settings.set(SETTINGS_OAUTH_TOKEN_KEY, oauthToken)
    oauthDeviceFlow = null

    logInfo('YouTube Music OAuth login succeeded')
    return { code: 0, message: 'YouTube Music 登录成功' }
  } catch (err) {
    return { code: -1, message: `OAuth 令牌请求失败: ${errorToMessage(err)}` }
  }
}

// Auto-refresh OAuth token if expiring (< 60s remaining)
async function ensureFreshOAuthToken() {
  if (!oauthToken || !oauthToken.refresh_token) return

  const now = Math.floor(Date.now() / 1000)
  if (oauthToken.expires_at && oauthToken.expires_at - now > 60) return

  const client = oauthClient || await discoverOAuthClient().catch(() => null)
  if (!client) return

  try {
    const response = await fetchWithTimeout(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YTTV_UA
      },
      body: JSON.stringify({
        client_id: client.client_id,
        client_secret: client.client_secret,
        grant_type: 'refresh_token',
        refresh_token: oauthToken.refresh_token
      })
    })

    if (!response.ok) {
      logWarn(`OAuth token refresh failed: HTTP ${response.status}`)
      oauthToken = null
      await getContext().settings.delete(SETTINGS_OAUTH_TOKEN_KEY)
      return
    }

    const tokenData = await response.json()
    oauthToken = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || oauthToken.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      scope: tokenData.scope || oauthToken.scope,
      token_type: tokenData.token_type || oauthToken.token_type
    }

    await getContext().settings.set(SETTINGS_OAUTH_TOKEN_KEY, oauthToken)
    logInfo('YouTube Music OAuth token refreshed')
  } catch (err) {
    logWarn(`OAuth token refresh error: ${errorToMessage(err)}`)
  }
}

// ─── Stream Proxy Server ────────────────────────────────────────────────
async function ensureProxyServer() {
  if (proxyServer && proxyPort > 0) return
  proxyServer = createServer((request, response) => {
    void handleProxyRequest(request, response)
  })
  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject)
    proxyServer.listen(0, '127.0.0.1', () => {
      const address = proxyServer.address()
      proxyPort = typeof address === 'object' && address ? address.port : 0
      proxyServer.off('error', reject)
      resolve()
    })
  })
}

async function handleProxyRequest(request, response) {
  try {
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }

    const match = /^\/(stream|image)\/([a-f0-9]+)$/.exec(request.url || '')
    const kind = match ? match[1] : null
    const entry = match ? proxyTokens.get(match[2]) : null

    if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) {
      response.statusCode = 403
      response.end('Invalid or expired YouTube Music proxy token')
      return
    }

    const upstreamHeaders = {
      'User-Agent': UA,
      Referer: YTM_DOMAIN,
      Origin: YTM_DOMAIN
    }
    if (entry.cookie) upstreamHeaders.Cookie = entry.cookie

    const range = request.headers.range
    if (kind === 'stream' && typeof range === 'string') {
      upstreamHeaders.Range = range
    }

    const upstream = await fetch(entry.url, { headers: upstreamHeaders, redirect: 'follow' })

    if (!upstream.ok) {
      response.statusCode = upstream.status
      response.end(`YouTube Music upstream error: HTTP ${upstream.status}`)
      return
    }

    response.statusCode = upstream.status
    for (const [name, value] of upstream.headers) {
      if (shouldProxyHeader(name)) response.setHeader(name, value)
    }
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (kind === 'stream') {
      response.setHeader('Content-Type', entry.contentType || upstream.headers.get('content-type') || 'audio/mp4')
    }
    if (kind === 'image') {
      response.setHeader('Cache-Control', 'private, max-age=21600')
    }
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    if (!upstream.body) {
      response.end()
      return
    }
    for await (const chunk of upstream.body) {
      response.write(chunk)
    }
    response.end()
  } catch (error) {
    response.statusCode = 502
    response.end(`YouTube Music proxy failed: ${errorToMessage(error)}`)
  }
}

function createProxyToken(entry, ttlMs) {
  const token = randomBytes(16).toString('hex')
  proxyTokens.set(token, { ...entry, expiresAt: Date.now() + ttlMs })
  // Cleanup expired tokens
  for (const [key, value] of proxyTokens) {
    if (value.expiresAt <= Date.now()) proxyTokens.delete(key)
  }
  return token
}

// ─── HTTP Utilities ─────────────────────────────────────────────────────
function defaultHeaders(cookie) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': UA,
    Referer: YTM_DOMAIN,
    Origin: YTM_DOMAIN
  }
  if (cookie) headers.Cookie = cookie
  return headers
}

async function fetchWithTimeout(input, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('YouTube Music request timeout, please try again')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// SAPISID hash authentication (ported from helpers.py)
function getSapisid(rawCookie) {
  if (!rawCookie) return null
  const cleaned = rawCookie.replace(/"/g, '')
  for (const part of cleaned.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) {
      const key = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (key === '__Secure-3PAPISID' || key === 'SAPISID') return value
    }
  }
  return null
}

function getAuthorization(sapisid, origin) {
  const timestamp = Math.floor(Date.now() / 1000)
  const hash = createHash('sha1')
  hash.update(`${timestamp} ${sapisid} ${origin}`)
  return `SAPISIDHASH ${timestamp}_${hash.digest('hex')}`
}

// ─── Track Normalization ────────────────────────────────────────────────
function normalizeTrack(song) {
  const videoId = song.videoId
  if (!videoId) return null

  const artists = song.artists || []
  const artist = artists.map(a => a.name).filter(Boolean).join(', ') || 'Unknown Artist'
  const album = song.album
  const albumName = typeof album === 'string' ? album : (album?.name || '')
  const thumbnails = song.thumbnails || []
  const cover = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : null

  return {
    id: `ytm:${videoId}`,
    title: song.title || 'Unknown Track',
    artist,
    album: albumName,
    filePath: `ytm:${videoId}`,
    fileName: `${artist} - ${song.title || 'Unknown Track'}`,
    duration: song.duration_seconds || 0,
    size: 0,
    cover,
    lyrics: null,
    translatedLyrics: null,
    source: 'ytm',
    ytmVideoId: videoId,
    streamUrl: null,
    format: 'm4a',
    sampleRate: 44100,
    bitrate: 0
  }
}

function extractVideoId(track) {
  if (!track) return null
  if (track.ytmVideoId) return track.ytmVideoId
  const id = track.id || track.filePath || ''
  if (id.startsWith('ytm:')) return id.slice(4)
  return null
}

function getContentType(format) {
  const mime = format?.mimeType || ''
  if (mime.includes('mp4')) return 'audio/mp4'
  if (mime.includes('webm')) return 'audio/webm'
  return 'audio/mpeg'
}

function shouldProxyHeader(name) {
  const excluded = [
    'connection', 'content-encoding', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'transfer-encoding', 'upgrade'
  ]
  return !excluded.includes(name.toLowerCase())
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function logInfo(msg) {
  getContext()?.logger?.info(msg)
}

function logWarn(msg) {
  getContext()?.logger?.warn(msg)
}
