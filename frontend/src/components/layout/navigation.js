import { BookOpen, GraduationCap, Library, MessagesSquare } from 'lucide-react';

/**
 * Primary navigation (top bar on desktop, bottom bar on phones). Account pages
 * (Settings, AI usage) live in the profile menu. Every item points at a real route.
 * `match(location)` decides the active item; detail pages belong to their section.
 */
const startsWith = (...prefixes) => (location) =>
  prefixes.some((prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`));

export const PRIMARY_NAV = [
  { to: '/', label: 'Home', icon: BookOpen, match: (location) => location.pathname === '/' || startsWith('/summarize')(location) },
  { to: '/library', label: 'Library', icon: Library, match: startsWith('/library') },
  { to: '/study', label: 'Study', icon: GraduationCap, match: startsWith('/study') },
  { to: '/ask', label: 'Ask AI', icon: MessagesSquare, match: startsWith('/ask') },
];

export const ACCOUNT_NAV = [
  { to: '/settings', label: 'Settings' },
  { to: '/usage', label: 'AI usage' },
];
