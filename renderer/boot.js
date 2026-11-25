'use strict';

// Wire the tabs and decide the first screen.
(function () {
  for (const b of document.querySelectorAll('#tabs button')) {
    b.addEventListener('click', () => UI.show(b.dataset.view));
  }
  (async () => {
    await UI.today.refresh();
    const needsSetup = await UI.onboarding.start();
    // Companion-first: the app opens on the companion chat once setup is done.
    UI.show(needsSetup ? 'onboarding' : 'ask');
  })();
})();
