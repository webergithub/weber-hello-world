export interface Video {
  id: string
  url: string
  cover: string
  title: string
  author: { id: string; name: string; avatar: string }
  stats: { likes: number; comments: number; shares: number }
  tags: string[]
  duration: number
}

export interface BehaviorEvent {
  videoId: string
  userId: string
  action: 'watch' | 'like' | 'comment' | 'share' | 'skip'
  watchRatio: number
  timestamp: number
}
