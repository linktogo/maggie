import { createRouter, createWebHistory } from 'vue-router';
import Board from './Board.vue';
import HistoryPage from './HistoryPage.vue';
import RetroDocPage from './RetroDocPage.vue';

// Accepts an injectable history implementation so tests can use
// createMemoryHistory() instead of touching the real browser URL.
export function createBoardRouter(history = createWebHistory()) {
  return createRouter({
    history,
    routes: [
      { path: '/', name: 'board', component: Board },
      { path: '/history', name: 'history', component: HistoryPage },
      { path: '/retro-doc', name: 'retro-doc', component: RetroDocPage },
    ],
  });
}
