// Example seed list. To start Pacifier with your own creators, copy this file
// to creators.local.js (ignored by git) and edit it before loading the
// extension. Otherwise add creators in Settings.
//
// Each entry needs a `name`. A `handle` (the @name in the channel's address)
// is the surest way to find a channel; `channel_id` (UC…) skips the lookup.
// Optional `priority`: "high" (newest video always included if under two
// weeks old) or "low" (only when there's room). Default is normal.
export default [
  { name: "Veritasium", handle: "@veritasium", priority: "high" },
  { name: "3Blue1Brown", handle: "@3blue1brown" },
];
