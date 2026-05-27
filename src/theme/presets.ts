export type ThemeId = 'default' | 'amoled'

export interface Theme {
  /** Base app background (maps to --cordia-bg). */
  background: string
  /** Primary card / panel background (maps to --cordia-card). */
  card: string
  /** Slightly elevated card background for overlays (optional). */
  cardElevated?: string
  /** Sidebar / chrome background (maps to --cordia-sidebar). */
  sidebar: string
  /** Background for lists like friends / servers (maps to --cordia-friends-bg). */
  friendsList: string
  /** Background for the composer / message draft (maps to --cordia-draft-bg). */
  messageDraft: string
  /** Border color (maps to --cordia-border). */
  border: string
  /** Accent surface color (maps to --cordia-accent). */
  accent: string
}

/** Discord default hex → HSL (exact from Grok spec) */
export const THEME_PRESETS: Record<ThemeId, Theme> = {
  default: {
    // Primary background (main chat/feed): #202225
    background: '220 7% 13%',
    // Secondary (sidebars, lists): #2F3136
    card: '220 7% 20%',
    cardElevated: '220 8% 23%', // Tertiary #36393F – inputs, popovers
    sidebar: '220 7% 20%',
    friendsList: '220 7% 20%',
    // Bottom input / compose: #40444B
    messageDraft: '223 8% 27%',
    // Borders: #292B2F – thin 1px, subtle
    border: '220 7% 17%',
    // Blurple accent: #5865F2
    accent: '235 86% 65%',
  },
  amoled: {
    // Primary background (main chat/feed): #1a1a1e
    background: '240 7% 11%',
    // Secondary (sidebars, lists): #121214
    sidebar: '240 5% 7%',
    friendsList: '240 5% 7%',
    // Attachment cards: #242429
    card: '240 6% 15%',
    cardElevated: '240 7% 17%',
    // Bottom input / compose: #202024 (derived)
    messageDraft: '240 6% 13%',
    // Borders: #18181b (derived)
    border: '240 6% 10%',
    // Blurple accent: #5865F2
    accent: '235 86% 65%',
  },
}

