# In-flight order across two polls

Three dispatches in flight. Between the polls, only live activity ticks on the first two; nobody reports.

## Before (main, sort = directory mtime)

```
poll 1: Decision ack (last report 09:03) | Stable in-flight order (last report 09:02) | Fix the tray schema (last report 09:01)
(between polls: activity ticks on the first two rows; no new report)
poll 2: Fix the tray schema (last report 09:01) | Stable in-flight order (last report 09:02) | Decision ack (last report 09:03)
```

## After (sort = last real update, id tie-break)

```
poll 1: Decision ack (last report 09:03) | Stable in-flight order (last report 09:02) | Fix the tray schema (last report 09:01)
(between polls: activity ticks on the first two rows; no new report)
poll 2: Decision ack (last report 09:03) | Stable in-flight order (last report 09:02) | Fix the tray schema (last report 09:01)
```
