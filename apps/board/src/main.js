import { createApp } from 'vue';
import App from './App.vue';
import { createBoardRouter } from './router.js';
import { initLocale } from './i18n.js';
import { initTheme } from './theme.js';
import './style.css';

initLocale();
initTheme();

const app = createApp(App);
app.use(createBoardRouter());
app.mount('#app');
