'use strict';

// Wire the tabs and decide the first screen.
(function () {
  for (const b of document.querySelectorAll('#tabs button')) {
    b.addEventListener('click', () => UI.show(b.dataset.view));
  }
  (async () => {
    let needsSetup = true;
    try {
      await UI.today.refresh();
    } catch (e) {
      // A crashed first refresh never strands the boot: Today reports its
      // own failure once shown, and the first screen still arrives.
    }
    try {
      needsSetup = await UI.onboarding.start();
    } catch (e) {
      // Unknown setup state after a crash: keep the first-run default so
      // setup is never silently skipped. The onboarding view reports its
      // own errors in place.
      needsSetup = true;
    }
    // Companion-first: the app opens on the companion chat once setup is done.
    UI.show(needsSetup ? 'onboarding' : 'ask');
  })();
})();
