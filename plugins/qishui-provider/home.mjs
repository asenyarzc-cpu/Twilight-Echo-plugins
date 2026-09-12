export const homeSections = [
  {
    id: 'discover',
    title: '发现好音乐',
    icon: 'pi pi-sparkles',
    method: 'fetchRecommendSongs',
    args: ['discover'],
    eyebrow: 'SODA PICKS',
    description: '从汽水音乐发现歌单中，遇见下一首喜欢的歌。'
  },
  {
    id: 'favorites',
    title: '我的喜欢',
    icon: 'pi pi-heart',
    method: 'fetchRecommendSongs',
    args: ['favorites'],
    requiresLogin: true,
    eyebrow: 'ON REPEAT',
    description: '收藏过的旋律，随时回来再听一遍。'
  }
]

export function createHome({
  appPost,
  mapPlaylist,
  mapTrack,
  fetchUserLibrary,
  requireAuth,
  playlistTypes
}) {
  let pendingPlaylists = null

  function fetchRecommendPlaylists() {
    if (pendingPlaylists) return pendingPlaylists
    pendingPlaylists = appPost('/luna/discover/mix', { count: 12 }, '')
      .then(({ json }) => {
        const playlists = []
        const ids = new Set()
        for (const block of json.inner_block || []) {
          for (const resource of block.resources || []) {
            const raw = resource.entity?.playlist || resource.playlist
            if (!raw) continue
            const playlist = mapPlaylist(raw)
            if (!playlist || ids.has(playlist.id)) continue
            ids.add(playlist.id)
            playlists.push({ ...playlist, owned: false })
            if (playlists.length === 12) return playlists
          }
        }
        return playlists
      })
      .finally(() => {
        pendingPlaylists = null
      })
    return pendingPlaylists
  }

  async function playlistPreview(id, count, cookie = '') {
    const { json } = await appPost(
      '/luna/playlist/detail',
      {
        playlist_id: id,
        playlist_type: playlistTypes.get(id) || 0,
        count,
        cursor: ''
      },
      cookie
    )
    return (json.media_resources || json.tracks || []).slice(0, count).map(mapTrack).filter(Boolean)
  }

  async function fetchRecommendSongs(section = 'discover') {
    if (typeof section !== 'string') section = 'discover'
    if (section === 'favorites') {
      const auth = await requireAuth()
      const { likedPlaylist } = await fetchUserLibrary()
      return likedPlaylist ? playlistPreview(likedPlaylist.id, 12, auth.cookie) : []
    }
    if (section !== 'discover') throw new Error('未知汽水音乐主页分区')
    const playlists = await fetchRecommendPlaylists()
    const results = await Promise.allSettled(
      playlists.slice(0, 3).map((p) => playlistPreview(p.id, 4))
    )
    const tracks = new Map()
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const track of result.value) tracks.set(track.id, track)
      }
    }
    if (!tracks.size && results.length && results.every((r) => r.status === 'rejected')) {
      throw results[0].reason
    }
    return [...tracks.values()]
  }

  return { fetchRecommendPlaylists, fetchRecommendSongs }
}
