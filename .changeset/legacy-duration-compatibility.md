---
'@julr/tenace': patch
---

Restore the duration strings accepted before v2, including long unit names, spaces, case-insensitive aliases, weeks, years, and numeric strings interpreted as milliseconds. Adapt the MIT-licensed parser from `@lukeed/ms` without adding a runtime dependency.

Widen `Duration` to `string | number` so duration values read from configuration remain assignable. Preserve the existing v2 forms, including `'0s'`, `'+1s'`, and `'1e3ms'`, and keep rejecting negative, malformed, and overflowing string durations.
