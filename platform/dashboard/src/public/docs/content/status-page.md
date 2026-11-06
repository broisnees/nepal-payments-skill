# Status page

A public page at [/status](/status) answers "is eSewa down?" for every gateway, from real live traffic. Each gateway also has its own page at `/status/<gateway>`, and the data is at `/status.json`. The pages are rendered on the server and cached for 60 seconds.

## What it shows

For each gateway:

- the current state: operational, degraded, down, or no data
- the error rate and p95 latency over the last 24 hours
- daily uptime bars for 90 days
- latency by hour of the day in Nepal time over the last 7 days
- incidents, opened automatically for windows where the error rate is over 20% or p95 latency over 5 seconds for at least 5 minutes

A gateway request counts as an error when the gateway answered 500 or above, timed out, or failed at the network level.

## Privacy

- Only `gateway.request` events from live environments count. Test traffic never appears.
- A minute of a gateway's data is shown only when it combines traffic from at least 3 different projects. Otherwise the page says there is not enough traffic.
- It shows rates and latency, never volumes, amounts or anything about a single merchant.
- The underlying minutes are kept for 90 days.
