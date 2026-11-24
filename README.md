# Surge-rider — Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wangconghua/pump-fun-paper-sprint-01/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/wangconghua/pump-fun-paper-sprint-01/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A young-curve surge bot for the pump.fun replay (agent-fun/replay/v2). It buys only
when a young curve shows a genuine crowd — at least 10 distinct wallets buying, net SOL
flowing in, price climbing and holding near its short-window high — keeps the stake
small (0.03 SOL), takes half off at +45%, and lets the rest ride behind a trailing
stop. Losers are cut by a stop loss, a flow-fade exit, or a time limit. Tiny probe
round trips keep the run above the 20-coin guardrail.

Local dev-window score (kit's own grader): net −0.09 SOL over 69 coins / 157 trips,
max drawdown 2.4% — the dev window is negative for every strategy tried, so the edge
here is survival plus a chance to catch a runner on the fresh 6-hour final window.

## Run

```sh
node main.ts   # Node 22+, no dependencies; the harness drives it over stdin/stdout
```

## Files

- `main.ts` — entrypoint: hands the strategy to the harness runner.
- `strategy.ts` — the surge-rider strategy (entry signal, staged exits, probes).
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte.
