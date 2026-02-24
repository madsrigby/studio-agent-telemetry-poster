# Cost Savings Method

## Current default rate
- `DEFAULT_HOURLY_RATE` fallback is now **45** (GBP/hour).

## Baseline minutes precedence
For each `tool_executed` event, baseline minutes are determined in this order:
1. `event.estimated_manual_minutes` (if provided in payload)
2. `HANDBOOK_BASELINE_MINUTES_JSON` env map (tool-specific)
3. built-in default map in `Analyticsfunction.ts`
4. final fallback = 3 minutes

## Formula
- `hours_saved = sum(baseline_minutes_per_event) / 60`
- `cost_saved = hours_saved * hourly_rate`

## Recommended production setup
- Set `DEFAULT_HOURLY_RATE=45` (or your agreed blended management rate).
- Set `HANDBOOK_BASELINE_MINUTES_JSON` from your handbook estimates.
- Optionally emit `estimated_manual_minutes` per event for highest accuracy.
