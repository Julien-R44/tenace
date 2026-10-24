---
'@julr/tenace': patch
---

Duration strings support long unit names, spaces, case-insensitive aliases, weeks, years, and unitless milliseconds. Parsing uses code adapted from `@lukeed/ms` under the MIT license, with no runtime dependency.

`Duration` accepts `string | number`, including values read from configuration. Strings such as `'0s'`, `'+1s'`, and `'1e3ms'` are valid. Negative, malformed, and overflowing string durations throw a `RangeError`.
