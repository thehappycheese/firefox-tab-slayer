# Tab Slayer

Tab Slayer is a Firefox extension that automatically closes tabs you have forgotten about.

The extension always permits the last 6 open tabs to remain open. If that limit is exceeded, the oldest eligible tabs are closed first until the count is back within the limit.

Every tab has a timer. If a tab sits untouched for 4 minutes, it is closed. Visiting a tab or navigating to a new page within it resets its timer. A sweep runs every minute to check for expired tabs.

The following tabs are never closed:

- The currently active tab in any window
- Pinned tabs
- Tabs playing audio
- Internal browser pages (about:, etc.)

To keep things simple, there are no adjustable settings. This extension has been tuned to suit the author, and if anyone else finds it useful thats great. Future releases may tweek the thresholds.