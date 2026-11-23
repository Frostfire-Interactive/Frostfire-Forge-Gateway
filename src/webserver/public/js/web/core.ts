// First, so errors while the rest of the client loads are forwarded too.
import '../core/clientlog';
// Before the UI is laid out: its scale for the window's size (and on a resize, before anything measures it).
import '../core/uiscale';
import '../core/socket';
import '../core/preventzoomcontrols';
import './notification';
import '../core/packets';
import '../core/gamepad';
import '../core/virtualcontroller';
import '../core/mobileui';
import '../core/mobilechat';
import '../core/minimap';

// Register Service Worker for sprite/asset caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.warn('[Service Worker] Registration failed:', error);
    });
  });
}